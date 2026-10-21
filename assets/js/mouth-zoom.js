// Zoom into Armando's photo (click, trackpad pinch, or touch pinch). A picture
// of me is nested inside his mouth; zooming all the way in lands on it so it
// fills the frame, with the frame gradually reshaping to fit it.
(function () {
  var STEP = 2.5;

  function smoothstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  document.querySelectorAll('.mouth-zoom').forEach(function (box) {
    var stage = box.querySelector('.mouth-zoom-stage');
    var inner = box.querySelector('.mouth-zoom-inner');
    var scale = 1, tx = 0, ty = 0;

    // The inner picture's unzoomed position and size. Uses computed styles
    // rather than offsetWidth etc., which round to whole pixels and throw the
    // final framing off at high zoom.
    function innerRect() {
      var cs = getComputedStyle(inner);
      return {
        x: parseFloat(cs.left), y: parseFloat(cs.top),
        w: parseFloat(cs.width), h: parseFloat(cs.height)
      };
    }

    // The zoom at which the inner picture is exactly as wide as the frame.
    function maxScale() {
      return box.clientWidth / innerRect().w;
    }

    function render(animate) {
      var r = innerRect();
      var max = maxScale();
      scale = Math.min(max, Math.max(1, scale));
      var w = box.clientWidth;
      var outerH = parseFloat(getComputedStyle(stage).height);
      var innerH = w * r.h / r.w;

      // Over the last stretch of zooming, ease the frame into the inner
      // picture's shape and pull the view onto it, so full zoom shows exactly
      // the inner picture.
      var progress = Math.log(scale) / Math.log(max);
      var pull = smoothstep(0.55, 1, progress);
      var h = lerp(outerH, innerH, pull);

      tx = Math.min(0, Math.max(w - w * scale, tx));
      ty = Math.min(0, Math.max(h - outerH * scale, ty));
      var targetX = (w - r.w * scale) / 2 - r.x * scale;
      var targetY = (h - r.h * scale) / 2 - r.y * scale;
      tx = lerp(tx, targetX, pull);
      ty = lerp(ty, targetY, pull);

      box.classList.toggle('animate', !!animate);
      box.style.height = scale > 1 ? h + 'px' : '';
      stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
      inner.style.opacity = smoothstep(1, 3, scale);
      box.classList.toggle('zoomed', scale > 1);
      box.classList.toggle('maxed', scale >= max - 0.001);
    }

    // Zoom by `factor`, keeping the point (x, y) in box coordinates fixed.
    function zoomAt(x, y, factor, animate) {
      var next = Math.min(maxScale(), Math.max(1, scale * factor));
      tx = x - (x - tx) * (next / scale);
      ty = y - (y - ty) * (next / scale);
      scale = next;
      render(animate);
    }

    function local(e) {
      var r = box.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function reset() {
      scale = 1; tx = 0; ty = 0;
      render(true);
    }

    // One click or tap's worth of zoom, going straight to full zoom when a
    // normal step would land just short of it.
    function stepFactor() {
      var max = maxScale();
      return scale * STEP * 1.5 >= max ? max / scale : STEP;
    }

    function isMaxed() {
      return scale >= maxScale() - 0.001;
    }

    // Trackpad pinch arrives as a ctrl+wheel event in Chrome and Firefox.
    box.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && scale === 1) return;
      e.preventDefault();
      var p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), false);
    }, { passive: false });

    // Safari sends trackpad pinches as gesture events instead.
    var gestureStart = 1;
    box.addEventListener('gesturestart', function (e) {
      e.preventDefault();
      gestureStart = scale;
    });
    box.addEventListener('gesturechange', function (e) {
      e.preventDefault();
      var p = local(e);
      zoomAt(p.x, p.y, gestureStart * e.scale / scale, false);
    });

    // Mouse: click to zoom in, drag to pan, click at full zoom to reset.
    var drag = null;
    box.addEventListener('mousedown', function (e) {
      drag = { x: e.clientX, y: e.clientY, tx: tx, ty: ty, moved: false };
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved && scale > 1) {
        tx = drag.tx + dx; ty = drag.ty + dy;
        render(false);
      }
    });
    window.addEventListener('mouseup', function (e) {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      if (moved || !box.contains(e.target)) return;
      if (isMaxed()) return reset();
      var p = local(e);
      zoomAt(p.x, p.y, stepFactor(), true);
    });

    // Touch: pinch to zoom, one finger pans while zoomed, tap to zoom in.
    var touch = null;
    function touchState(e) {
      var a = e.touches[0], b = e.touches[1] || a;
      var c = local({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
      return { x: c.x, y: c.y, dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), n: e.touches.length };
    }
    box.addEventListener('touchstart', function (e) {
      touch = touchState(e);
      touch.moved = false;
    }, { passive: true });
    box.addEventListener('touchmove', function (e) {
      if (!touch) return;
      var now = touchState(e);
      if (now.n === 2 && touch.n === 2) {
        e.preventDefault();
        if (touch.dist > 0) zoomAt(now.x, now.y, now.dist / touch.dist, false);
        tx += now.x - touch.x; ty += now.y - touch.y;
        render(false);
        touch.moved = true;
      } else if (now.n === 1 && scale > 1) {
        e.preventDefault();
        tx += now.x - touch.x; ty += now.y - touch.y;
        render(false);
        if (Math.abs(now.x - touch.x) + Math.abs(now.y - touch.y) > 1) touch.moved = true;
      } else if (now.n !== touch.n) {
        touch.moved = true;
      }
      var moved = touch.moved;
      touch = now;
      touch.moved = moved;
    }, { passive: false });
    box.addEventListener('touchend', function (e) {
      if (!touch) return;
      if (e.touches.length) { touch = touchState(e); touch.moved = true; return; }
      var tapped = !touch.moved;
      var p = { x: touch.x, y: touch.y };
      touch = null;
      if (!tapped) return;
      // Stop the emulated mouse events from zooming a second time.
      e.preventDefault();
      if (isMaxed()) return reset();
      zoomAt(p.x, p.y, stepFactor(), true);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && scale > 1) reset();
    });

    window.addEventListener('resize', function () {
      if (scale > 1) render(false);
    });
  });
})();
