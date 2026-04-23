---
title: "My memory isn't getting worse, it's just using exponential decay"
description: "Implementing a time travel debugger for a WASM interpreter using exponential decay to efficiently manage execution snapshots"
date: 2026-03-15
draft: false
tags: ["rust", "data structures", "debuggers", "interpreters", "wasm"]
categories: ["programming"]
---

[I've been working on a WASM interpreter from scratch.](https://github.com/friendlymatthew/gabagool) The unique feature is that it's completely snapshotable, down to the instruction level. At any point during execution, you can call `snapshot()` and it will write out the entire execution state into a list of bytes, capturing everything up to that exact instruction. You can restore it later and execution picks up right where it left off.

Here's a demo running Conway's Game of Life. You snapshot the simulation mid-tick, fork it into a new process, and watch both diverge from the same state:

<div class="post-image-centered">
<img src="/images/demo.gif" alt="Conway's Game of Life demo" />
</div>

I found snapshotting an interesting feature to implement because it ties itself so well to a [time travel debugger](https://en.wikipedia.org/wiki/Time_travel_debugging). Say you're stepping through a program trying to track down a bug. With a normal debugger, if you step one instruction too far, you have to restart the whole session and carefully step back to where you were. {{< hover-image src="/images/memento-cat.gif" alt="memento cat" width="350" caption="for the longest time I thought the movie was spelled momento" >}}A time travel debugger lets you just step backwards{{< /hover-image >}}, or jump to any point in the program's execution history.

# The problem space

In order to build a time travel debugger, we need a way to store history.

The most naive implementation I thought of would be to store every snapshot at every instruction. This obviously doesn't scale well. Each snapshot from the Game of Life demo is ~1.2 MB. On a MacBook Air with 16 GB of RAM, that gives you about 13,000 snapshots before you OOM. A WASM program can burn through 13,000 instructions in milliseconds. You could only keep the $N$ most recent snapshots, but if the program hits a tight loop, all $N$ snapshots end up inside that loop and you lose all outer context.

We don't need to store every snapshot. Given any snapshot, we can always replay forward from it and reach the same execution state. So when we want to step back to instruction 100 but our nearest snapshot is at instruction 90, we can replay forward 10 instructions to reconstruct the state.

The challenge lies in which snapshots to keep and which ones to discard. We want recent history to be dense, so stepping back 1 or 2 instructions is instant. But we also want to reach far into the past, even if the gaps are bigger there.

# The nerd snipe

[When I shared my project on lobste.rs](https://lobste.rs/s/eu5uiz/fully_snapshotable_wasm_interpreter), I was linked an [amazing blog post](https://awelonblue.wordpress.com/2013/01/24/exponential-decay-of-history-improved/). The author David Barbour introduces a data structure called an exponential decay buffer. The idea is simple: keep lots of recent snapshots and gradually fewer as you go further back. Barbour proceeds to drop some {{< hover-image src="/images/suhdud.jpg" alt="suhdud" width="350" >}}#knowledge{{< /hover-image >}} about how you can hold deep history in very little space, at the cost of losing intermediate detail the further back you go.

The density of snapshots halves at a fixed interval called the **half life**. This turns out to be incredibly space efficient, because each half life worth of storage doubles your reach. If you can hold 1,000 snapshots with a half life of 50, you don't just cover the last 1,000 instructions. You cover $2^{1000/50} = 2^{20} \approx \text{1 million}$ instructions. Store 2,000 snapshots and you get $2^{40}$, roughly a trillion instructions.

Play with the sliders below to see how the number of snapshots and half life affect your reach:

<div style="margin: 20px 0; padding: 20px; border: 2px solid #a2a9b1; background: #f8f9fa; border-radius: 4px;">
  <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
    <label style="color: #666; font-size: 14px; min-width: 100px;">snapshots:</label>
    <input type="range" id="reach-snapshots" min="100" max="5000" value="1000" step="100" style="flex: 1;" />
    <span id="reach-snapshots-val" style="color: #e25822; font-weight: bold; font-size: 14px; min-width: 45px;">1000</span>
  </div>
  <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
    <label style="color: #666; font-size: 14px; min-width: 100px;">half life:</label>
    <input type="range" id="reach-halflife" min="10" max="200" value="50" step="5" style="flex: 1;" />
    <span id="reach-halflife-val" style="color: #e25822; font-weight: bold; font-size: 14px; min-width: 45px;">50</span>
  </div>
  <div style="text-align: center; font-size: 18px; color: #000; margin-bottom: 8px;">
    $2^{\,}$<sup style="font-size: 16px;"><span id="reach-n" style="color: #e25822;">1000</span> / <span id="reach-h" style="color: #e25822;">50</span></sup> = $2^{\,}$<sup style="font-size: 16px;"><span id="reach-exp" style="color: #e25822;">20</span></sup> = <span id="reach-value" style="color: #e25822; font-weight: bold;"></span>
  </div>
  <div style="text-align: center; font-size: 16px; color: #000; padding: 12px 16px 0;">
    With <strong><span id="reach-snap-txt">1,000</span></strong> snapshots where every <strong><span id="reach-hl-txt">50</span></strong> snapshots back you keep half as many, you can debug the last
  </div>
  <div style="text-align: center; padding: 2px 0 12px;">
    <span style="font-size: 28px; font-weight: bold; color: #e25822;"><span id="reach-display"></span></span> <span id="reach-unit" style="font-size: 16px; color: #999;">instructions</span>
  </div>
</div>

<script>
(function() {
  var snapSlider = document.getElementById('reach-snapshots');
  var hlSlider = document.getElementById('reach-halflife');
  var snapVal = document.getElementById('reach-snapshots-val');
  var hlVal = document.getElementById('reach-halflife-val');
  var reachN = document.getElementById('reach-n');
  var reachH = document.getElementById('reach-h');
  var reachExp = document.getElementById('reach-exp');
  var reachValue = document.getElementById('reach-value');
  var reachDisplay = document.getElementById('reach-display');
  var reachSnapTxt = document.getElementById('reach-snap-txt');
  var reachHlTxt = document.getElementById('reach-hl-txt');
  var reachUnit = document.getElementById('reach-unit');

  function fmt(n) {
    if (n >= 1e12) return (n / 1e12).toFixed(1) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' million';
    if (n >= 1e3) return Math.round(n).toLocaleString();
    return Math.round(n).toString();
  }

  function update() {
    var n = parseInt(snapSlider.value);
    var h = parseInt(hlSlider.value);
    var exp = n / h;
    var reach = Math.pow(2, exp);

    snapVal.textContent = n;
    hlVal.textContent = h;
    reachN.textContent = n;
    reachH.textContent = h;
    reachExp.textContent = exp % 1 === 0 ? exp : exp.toFixed(1);
    reachValue.textContent = fmt(reach);
    reachDisplay.textContent = fmt(reach);
    reachSnapTxt.textContent = n.toLocaleString();
    reachHlTxt.textContent = h;
    reachUnit.textContent = reach < 1.5 ? 'instruction' : 'instructions';
  }

  snapSlider.addEventListener('input', update);
  hlSlider.addEventListener('input', update);
  update();
})();
</script>

In practice, we pick a buffer size and half life up front. Every instruction, we push a new snapshot. Once the buffer is full, each new snapshot means evicting an old one.

You could deterministically evict snapshots like evicting the $N$th oldest snapshot, but you'll run into a problem that Barbour describes as _temporal aliasing_. If eviction is deterministic, it can synchronize with periodic behavior in the program. If you're stuck in a tight loop, you'd evict snapshots at the same phase of the loop every time, creating blind spots in your history. By making eviction probabilistic, we break any synchronization. Older snapshots are still far more likely to be evicted, but which specific one gets dropped varies each time.

Barbour explains that the half life, eviction strategy, and buffer size are all tunable per application. He also concludes the blog post by dropping an implementation of the exponential buffer {{< hover-image src="/images/dorian.png" alt="Dorian" width="350" caption="smallest haskell dev" >}} in Haskell.{{< /hover-image >}}

# The implementation

For the remainder of this blog post, I'll be specific to my time travel debugger and walk through my implementation of an exponential buffer.

Our **eviction strategy** uses geometric sampling. When the buffer is full, we pick which snapshot to evict by sampling:

$$i = \left\lfloor \frac{\log(U)}{\log\left(1 - \frac{\ln 2}{h}\right)} \right\rfloor$$

where $U \sim \text{Uniform}(0, 1)$ and $h$ is the half life. Lower indices (older entries) are exponentially more likely to be evicted than higher indices (recent entries). The half life parameter $h$ controls the curve: an entry at index $i$ is twice as likely to be evicted as one $h$ indices closer to the newest.

The visualization below shows the eviction probability for each slot in a buffer of 100. Drag the slider to change the half life and watch how the distribution shifts. Slots on the left are older and get evicted more often (higher bar height). Slots on the right are newer and almost never touched.

<div id="decay-viz" style="margin: 20px 0; padding: 16px; border: 2px solid #a2a9b1; background: #f8f9fa; border-radius: 4px;">
  <div style="color: #000; font-size: 14px; margin-bottom: 8px;"><strong>buffer capacity:</strong> <span style="color: #e25822; font-weight: bold;">100</span> &nbsp; <strong>half life:</strong> <span id="half-life-title" style="color: #e25822; font-weight: bold;">50</span></div>
  <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
    <label for="half-life-slider" style="color: #666; font-size: 14px; white-space: nowrap;">half_life:</label>
    <input type="range" id="half-life-slider" min="20" max="80" value="50" step="1" style="flex: 1;" />
    <span id="half-life-value" style="color: #e25822; font-weight: bold; font-size: 14px; min-width: 24px;">50</span>
  </div>
  <canvas id="decay-canvas" style="width: 100%; height: 300px; background: #f0f0f0; border: 1px solid #a2a9b1;"></canvas>
  <div style="display: flex; justify-content: space-between; margin-top: 6px;">
    <span style="color: #999; font-size: 12px;">← older (more likely to evict)</span>
    <span style="color: #999; font-size: 12px;">newer (less likely to evict) →</span>
  </div>
</div>

<script>
(function() {
  var canvas = document.getElementById('decay-canvas');
  var ctx = canvas.getContext('2d');
  var slider = document.getElementById('half-life-slider');
  var valueDisplay = document.getElementById('half-life-value');
  var bufferSize = 100;
  var dpr = window.devicePixelRatio || 1;
  var logW = 700, logH = 300;

  function resize() {
    canvas.width = logW * dpr;
    canvas.height = logH * dpr;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.aspectRatio = logW + ' / ' + logH;
  }
  resize();
  window.addEventListener('resize', function() { resize(); draw(parseFloat(slider.value)); });

  function draw(halfLife) {
    var w = logW, h = logH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var p = Math.LN2 / halfLife;
    var probs = [];
    var maxProb = 0;

    for (var i = 0; i < bufferSize; i++) {
      var prob = p * Math.pow(1 - p, i);
      probs.push(prob);
      if (prob > maxProb) maxProb = prob;
    }

    // grid lines
    ctx.strokeStyle = '#CCCCCC';
    ctx.lineWidth = 1;
    for (var g = 0; g < 5; g++) {
      var gy = h - (g / 4) * (h - 30);
      ctx.beginPath();
      ctx.moveTo(40, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    // y-axis labels
    ctx.fillStyle = '#999999';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    for (var g = 0; g < 5; g++) {
      var gy = h - (g / 4) * (h - 30);
      var label = (maxProb * g / 4 * 100).toFixed(1) + '%';
      ctx.fillText(label, 36, gy + 4);
    }

    // bars: gradient from secondary-color (#0066FF) to widget-pink (#FF69B4)
    var barW = (w - 74) / bufferSize;
    for (var i = 0; i < bufferSize; i++) {
      var barH = (probs[i] / maxProb) * (h - 30);
      var x = 42 + i * barW;
      var y = h - barH;

      var ratio = i / bufferSize;
      var r = Math.round(255 * (1 - ratio) + 0 * ratio);
      var g = Math.round(105 * (1 - ratio) + 102 * ratio);
      var b = Math.round(180 * (1 - ratio) + 255 * ratio);
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fillRect(x, y, barW - 1, barH);
    }

    // half-life marker (nav-orange)
    var hlX = 42 + halfLife * barW;
    ctx.strokeStyle = '#FF6600';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(hlX, 0);
    ctx.lineTo(hlX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#FF6600';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('half life', hlX, 14);
  }

  var titleDisplay = document.getElementById('half-life-title');
  slider.addEventListener('input', function() {
    valueDisplay.textContent = slider.value;
    titleDisplay.textContent = slider.value;
    draw(parseFloat(slider.value));
  });

  draw(50);
})();
</script>

For the debugger, I set the **half life** to 50 and **buffer capacity** to 1,000 snapshots. That's $2^{1000/50} = 2^{20} \approx 1{,}048{,}576$ instructions of reachable history. And the eviction curve is steep. Old snapshots get aggressively culled while recent history stays almost untouched:

<div id="fixed-decay-viz" style="margin: 20px 0; padding: 16px; border: 2px solid #a2a9b1; background: #f8f9fa; border-radius: 4px;">
  <div style="color: #000; font-size: 14px; margin-bottom: 12px;"><strong>buffer capacity:</strong> <span style="color: #e25822; font-weight: bold;">1,000</span> &nbsp; <strong>half life:</strong> <span style="color: #e25822; font-weight: bold;">50</span></div>
  <canvas id="fixed-decay-canvas" style="width: 100%; background: #f0f0f0; border: 1px solid #a2a9b1;"></canvas>
  <div style="display: flex; justify-content: space-between; margin-top: 6px;">
    <span style="color: #999; font-size: 12px;">← older (more likely to evict)</span>
    <span style="color: #999; font-size: 12px;">newer (less likely to evict) →</span>
  </div>
</div>

<script>
(function() {
  var canvas = document.getElementById('fixed-decay-canvas');
  var ctx = canvas.getContext('2d');
  var bufferSize = 1000;
  var halfLife = 50;
  var dpr = window.devicePixelRatio || 1;
  var logW = 700, logH = 300;

  function resize() {
    canvas.width = logW * dpr;
    canvas.height = logH * dpr;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.aspectRatio = logW + ' / ' + logH;
  }
  resize();
  window.addEventListener('resize', function() { resize(); draw(); });

  function draw() {
    var w = logW, h = logH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var p = Math.LN2 / halfLife;
    var probs = [];
    var maxProb = 0;

    for (var i = 0; i < bufferSize; i++) {
      var prob = p * Math.pow(1 - p, i);
      probs.push(prob);
      if (prob > maxProb) maxProb = prob;
    }

    // grid lines
    ctx.strokeStyle = '#CCCCCC';
    ctx.lineWidth = 1;
    for (var g = 0; g < 5; g++) {
      var gy = h - (g / 4) * (h - 30);
      ctx.beginPath();
      ctx.moveTo(40, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    // y-axis labels
    ctx.fillStyle = '#999999';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    for (var g = 0; g < 5; g++) {
      var gy = h - (g / 4) * (h - 30);
      var label = (maxProb * g / 4 * 100).toFixed(1) + '%';
      ctx.fillText(label, 36, gy + 4);
    }

    // bars
    var barW = (w - 74) / bufferSize;
    var minBarW = Math.max(barW, 1);
    for (var i = 0; i < bufferSize; i++) {
      var barH = (probs[i] / maxProb) * (h - 30);
      var x = 42 + i * ((w - 74) / bufferSize);
      var y = h - barH;

      var ratio = i / bufferSize;
      var r = Math.round(255 * (1 - ratio) + 0 * ratio);
      var g = Math.round(105 * (1 - ratio) + 102 * ratio);
      var b = Math.round(180 * (1 - ratio) + 255 * ratio);
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fillRect(x, y, minBarW, barH);
    }

    // half-life marker
    var hlX = 42 + halfLife * ((w - 74) / bufferSize);
    ctx.strokeStyle = '#FF6600';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(hlX, 0);
    ctx.lineTo(hlX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#FF6600';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('half life', hlX, 14);
  }

  draw();
})();
</script>

Here's the core of the implementation. Each snapshot is stored alongside its instruction count. Since the instruction count only ever increases, the buffer is always sorted for free. That means jumping to any point in history is a binary search: find the nearest snapshot before the target instruction, then replay forward from there. For randomness, I use a simple xorshift PRNG to avoid pulling in a dependency for something this small.

```rust
type Snapshot = Vec<u8>;

struct ExponentialDecayBuffer {
    // stores a list of tuples of (instruction_count, snapshot data)
    buf: Vec<(u64, Snapshot)>,
    capacity: usize,
    half_life: f32,
    rng: u64
}

impl ExponentialDecayBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: Vec::with_capacity(capacity),
            capacity,
            half_life: 50.0,
            // the seed
            rng: 0xABBA_ABBA,
        }
    }

    pub fn find_nearest_before(&self, instruction_count: u64) -> Option<&Snapshot> {
        match self.buf.binary_search_by_key(&instruction_count, |(t, _)| *t) {
            Ok(i) => Some(&self.buf[i]),
            Err(0) => None,
            Err(i) => Some(&self.buf[i - 1]),
        }
    }

    pub fn push(&mut self, instruction_count: u64, snapshot: Snapshot) {
        let entry = (instruction_count, snapshot);

        if self.buf.len() < self.capacity {
            self.buf.push(entry);
            return;
        }

        let i = self.sample_geometric_index();
        let i = i.clamp(0, self.buf.len() - 2);

        self.buf.remove(i + 1);
        self.buf.push(entry);
    }

    fn sample_geometric_index(&mut self) -> usize {
        let u = self.generate_random_f32();
        let i = u.log(1.0 - 2_f32.ln() / self.half_life);
        i.floor() as usize
    }

    fn generate_random_f32(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;

        (self.rng >> 40) as f32 / (0xFF_FFFF as f32)
    }
}
```

What's nice about the buffer is that it's a clean abstraction. The debugger doesn't have to think about what to keep or what to throw away. It just calls `push` with a snapshot, and the buffer handles eviction internally. When the debugger needs to step backward, it calls `find_nearest_before` and gets the best available snapshot. All the tricky stuff, the geometric sampling, the probabilistic eviction, the half life tuning, is hidden behind two methods.

Wiring it into the debugger is pretty simple. Every $N$ instructions, we snapshot and push it into the buffer. Stepping forward just runs an instruction. Stepping backward finds the nearest earlier snapshot, restores it, and replays forward to where we want to be. If you're curious, [here's the actual debugger](https://github.com/friendlymatthew/gabagool/blob/aa6ef7b2004e04c244941ff51f5ed7fbf9cca4da/src/debugger.rs) and the [decay buffer](https://github.com/friendlymatthew/gabagool/blob/aa6ef7b2004e04c244941ff51f5ed7fbf9cca4da/src/exponential_decay.rs) used in my project. But the following is a simplified version that gets the message across:

```rust
struct Interpreter;

impl Interpreter {
    fn is_completed(&self) -> bool { todo!() }
    fn run_one_instruction(&mut self) { todo!() }
    fn replay_forward(&mut self, n: u64) { todo!() }
    fn snapshot(&self) -> Vec<u8> { todo!() }
    fn restore(&mut self, snapshot: &[u8]) { todo!() }
}

enum StepResult {
    Stepped,
    ReachedStart,
    Completed,
}

struct Debugger {
    interpreter: Interpreter,
    buffer: ExponentialDecayBuffer,
    instruction_count: u64,
}

impl Debugger {
    pub fn new(interpreter: Interpreter, mut buffer: ExponentialDecayBuffer) -> Self {
        // snapshot at instruction 0 so step_back always has a base to replay from
        let snapshot = interpreter.snapshot();
        buffer.push(0, snapshot);

        Self {
            interpreter,
            buffer,
            instruction_count: 0,
        }
    }

    pub fn step_forward(&mut self) -> StepResult {
        if self.interpreter.is_completed() {
            return StepResult::Completed;
        }

        self.interpreter.run_one_instruction();
        self.instruction_count += 1;

        // periodically snapshot
        if self.instruction_count.is_multiple_of(1_000) {
            let snapshot = self.interpreter.snapshot();
            self.buffer.push(self.instruction_count, snapshot);
        }

        StepResult::Stepped
    }

    pub fn step_back(&mut self) -> StepResult {
        if self.instruction_count == 0 {
            return StepResult::ReachedStart;
        }

        let target = self.instruction_count - 1;

        // find the latest snapshot before our target
        let (snapshot_ic, snapshot) = self
            .buffer
            .find_nearest_before(target)
            .expect("we snapshot at instruction 0");

        // restore that snapshot, then replay forward to the target
        self.interpreter.restore(snapshot);
        self.interpreter.replay_forward(target - snapshot_ic);
        self.instruction_count = target;

        StepResult::Stepped
    }
  }
```
