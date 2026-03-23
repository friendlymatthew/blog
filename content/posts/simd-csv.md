---
title: "Let's see Paul Allen's SIMD CSV parser"
date: 2026-03-20
draft: false
featured_image: "/images/paulallenscard.png"
hide_featured_image: true
tags: ["rust", "simd", "csv", "file formats"]
categories: ["programming"]
# featured_image_caption: "_Look at the subtle vectorization. The tasteful thickness of it. Oh my god, it even has vmull_p64_"
---

<div style="text-align: center;">
<div style="display: inline-block; width: 300px; text-align: center;">
<img src="/images/paulallenscard.png" alt="Paul Allen's card" style="width: 100%;" />
<p class="image-caption"><em>Look at the subtle nibble extraction. The tasteful lookup tables of it. Oh my god, it even has <code>vqtbl1q_u8</code> and <code>vmull_p64</code>.</em></p>
</div>
</div>

<br>

[A year ago I wrote a CSV parser that is able to parse 64 characters at a time.](https://github.com/friendlymatthew/simdcsv) It's purely for research and hand waves over crucial steps for a production parser like validation. But the core algorithm uses SIMD and bitwise operations to classify and filter structural characters in bulk, and these are the techniques I'll be talking about today.

If you are new to SIMD, I would recommend pausing here and reading [McYoung's introduction to SIMD](https://mcyoung.xyz/2023/11/27/simd-base64). But here's a quick primer on SIMD:

- CPU clock speeds [hit a ceiling about 20 years ago](https://en.wikipedia.org/wiki/Dennard_scaling#Breakdown_of_Dennard_scaling_around_2006). We can't make cores faster without melting them, so instead of processing one value at a time faster, we process multiple values at once (wider)
- SIMD (single instruction, multiple data) lets you perform the same operation on a fixed batch of data (usually 16 or 32 bytes, or even 64 bytes) in the same time it takes to process a single byte
- SIMD code (or vectorized code) is most effective when it's branchless, meaning it avoids `if` statements, loops, and function calls, performing the same operations regardless of input
- Each architecture has a different set of SIMD instructions. See Rust's [std::arch](https://doc.rust-lang.org/stable/core/arch/) module

# The simdjson paper

For a given topic, there are always a couple of standout papers that are considered required reading for that problem space. For example, as Joseph Beryl Koshakow put it, "the Amazon DynamoDB and Google Spanner papers are among the canonical database papers that all database developers should read." <sup>{{< hover-image src="/images/josephberyl.png" alt="Joseph Beryl" width="450" caption="<a href='https://joekoshakow.com' target='_blank'>joekoshakow.com</a>" >}}[source]{{< /hover-image >}}</sup> &nbsp; He then said, "Matthew is one of the smartest engineers I know and is much taller than me." <sup>[source-needed]</sup>

For SIMD, I would argue the [simdjson paper](https://arxiv.org/pdf/1902.08318) is the paper to read. JSON parsing is a familiar problem, but simdjson solves it by scanning and processing 64 bytes at a time. If you prefer a video, {{< hover-image src="/images/lemire_vs_us.png" alt="Daniel Lemire" width="450" caption="<a href='https://lemire.me/blog/' target='_blank'>Daniel Lemire</a> vs the rest of us" >}}Daniel Lemire{{< /hover-image >}}, the co-author of the paper and the LeBron James of SIMD, [gave a talk about it as well](https://www.youtube.com/watch?v=wlvKAT7SZIQ).

The rest of the blog post will explain some of the techniques outlined in the paper that I used for my CSV parser. The SIMD instructions I use are `ARM NEON`, but `x86` has direct equivalents for all of them.

# CSV and thinking parallel

Here's a typical CSV:

<table>
<thead>
<tr><th>name</th><th>age</th><th>location</th></tr>
</thead>
<tbody>
<tr><td>alice</td><td>30</td><td>Irvine</td></tr>
<tr><td>bob</td><td>25</td><td>123 Union Square, New York New York</td></tr>
<tr><td>lonely charlie</td><td>28</td><td>where she said, "hi"<br>to me</td></tr>
</tbody>
</table>

Which, as a raw byte stream adhering to the [CSV RFC4180 spec](https://www.rfc-editor.org/rfc/rfc4180.html), looks like this:

<pre class="csv-raw">name,age,location\r\n
alice,30,Irvine\n
bob,25,"123 Union Square, New York New York"\n
lonely charlie,28,"where she said, ""hi""\nto me"</pre>

Every file format has **structural characters**, the characters that give shape to an otherwise flat sequence of bytes. In CSV, commas (`,`) separate columns, newlines (`\n` or `\r\n`) separate rows, and quotes (`"`) wrap fields that contain structural characters themselves, like `"123 Union Square, New York New York"`. To include a literal quote inside a quoted field, you double it: `"hi"` becomes `""hi""`.

Parsing a CSV boils down to 3 steps. First, classify every byte:

<pre class="csv-raw">name<span class="sc-comma">,</span>age<span class="sc-comma">,</span>location<span class="sc-newline">\r\n</span>
alice<span class="sc-comma">,</span>30<span class="sc-comma">,</span>Irvine<span class="sc-newline">\n</span>
bob<span class="sc-comma">,</span>25<span class="sc-comma">,</span><span class="sc-quote">"</span>123 Union Square<span class="sc-comma">,</span> New York New York<span class="sc-quote">"</span><span class="sc-newline">\n</span>
lonely charlie<span class="sc-comma">,</span>28<span class="sc-comma">,</span><span class="sc-quote">"</span>where she said<span class="sc-comma">,</span> <span class="sc-quote">""</span>hi<span class="sc-quote">""</span><span class="sc-newline">\n</span>to me<span class="sc-quote">"</span></pre>

But not all of these are real delimiters. The comma inside `"where she said, ""hi""\nto me"` is just text, the `\n` is part of the field value, and the `""` around `hi` are escape sequences, not boundaries. So we filter them out:

<pre class="csv-raw">name<span class="sc-comma">,</span>age<span class="sc-comma">,</span>location<span class="sc-newline">\r\n</span>
alice<span class="sc-comma">,</span>30<span class="sc-comma">,</span>Irvine<span class="sc-newline">\n</span>
bob<span class="sc-comma">,</span>25<span class="sc-comma">,</span><span class="sc-filtered">"</span>123 Union Square<span class="sc-filtered">,</span> New York New York<span class="sc-filtered">"</span><span class="sc-newline">\n</span>
lonely charlie<span class="sc-comma">,</span>28<span class="sc-comma">,</span><span class="sc-filtered">"</span>where she said<span class="sc-filtered">,</span> <span class="sc-filtered">""</span>hi<span class="sc-filtered">""</span><span class="sc-filtered">\n</span>to me<span class="sc-filtered">"</span></pre>

What remains are the characters that actually separate columns and rows:

<pre class="csv-raw">name<span class="sc-comma">,</span>age<span class="sc-comma">,</span>location<span class="sc-newline">\r\n</span>
alice<span class="sc-comma">,</span>30<span class="sc-comma">,</span>Irvine<span class="sc-newline">\n</span>
bob<span class="sc-comma">,</span>25<span class="sc-comma">,</span>123 Union Square, New York New York<span class="sc-newline">\n</span>
lonely charlie<span class="sc-comma">,</span>28<span class="sc-comma">,</span>where she said, ""hi""\nto me</pre>

Finally, we record the position of each remaining structural character. These offsets are all we need to slice the original byte stream into rows and fields.

The trick is that each of these steps can be performed on many bytes at once.

## Step 1: Classify structural characters

A scalar approach would classify each byte by comparing it against every structural character one by one.

{{< hover-image src="/images/geoff.png" alt="Geoff Langdale" width="450" caption="<a href='https://branchfree.org/' target='_blank'>branchfree.org</a>" >}}Geoff Langdale{{< /hover-image >}}, co-author of simdjson and creator of [Hyperscan](https://branchfree.org/2019/02/28/paper-hyperscan-a-fast-multi-pattern-regex-matcher-for-modern-cpus/), devised a technique called vectorized classification that can classify 16/32/64 bytes in a single pass.

The idea is to build a pair of lookup tables that act like a perfect hash. Every structural character maps to its class (`COMMA` = 1, `QUOTE` = 2, `NEWLINE` = 3), and everything else maps to 0. We could build a 256-entry lookup table, but common SIMD lookup instructions like `pshufb` and `vqtbl1q_u8` only support 16-entry tables (4-bit indices).

Since a byte is 8 bits, we split each byte in half. Each half is called a nibble, and in hex, each digit is exactly one nibble.

| Character | Hex  | High nibble | Low nibble |
| --------- | ---- | ----------- | ---------- |
| ,         | 0x2C | 0x2         | 0xC        |
| "         | 0x22 | 0x2         | 0x2        |
| \n        | 0x0A | 0x0         | 0xA        |
| \r        | 0x0D | 0x0         | 0xD        |

We build one table indexed by the high nibble and one by the low nibble. Each returns a set of candidate classes for that nibble. `AND` the results together, and only the correct class survives.

For example, let's trace the comma (`0x2C`) through both tables:

<div style="display: flex; gap: 24px; flex-wrap: wrap; margin: 16px 0;">
<div>
<strong>High nibble table</strong>
<table>
<thead><tr><th>Index</th><th>Returns</th></tr></thead>
<tbody>
<tr><td>0x0</td><td>NEWLINE</td></tr>
<tr style="background: #f8d7da;"><td>0x2</td><td>COMMA | QUOTE</td></tr>
<tr><td>...</td><td>0</td></tr>
</tbody>
</table>
</div>
<div>
<strong>Low nibble table</strong>
<table>
<thead><tr><th>Index</th><th>Returns</th></tr></thead>
<tbody>
<tr><td>0x2</td><td>QUOTE</td></tr>
<tr><td>0xA</td><td>NEWLINE</td></tr>
<tr style="background: #f8d7da;"><td>0xC</td><td>COMMA</td></tr>
<tr><td>0xD</td><td>NEWLINE</td></tr>
<tr><td>...</td><td>0</td></tr>
</tbody>
</table>
</div>
</div>

<pre class="csv-raw">  0x2C  →  high nibble 0x2 returns <span class="sc-comma">COMMA | QUOTE</span>
          low nibble  0xC returns <span class="sc-comma">COMMA</span>
          AND result:             <span class="sc-comma">COMMA</span> ✓</pre>

Notice how the high nibble `0x2` is shared by both `,` and `"`, so it returns both as candidates. But the low nibble `0xC` only matches `COMMA`. The `AND` eliminates `QUOTE`, leaving just `COMMA`.

Building these lookup tables requires some care. Because the `AND` combines results from 2 independent lookups, you're effectively designing a grid. Any byte whose high nibble matches and whose low nibble matches will be classified.

Say you want to group `0xA0`, `0xB4`, and `0xB0` into a class. The high nibbles are {`0xA`, `0xB`} and the low nibbles are {`0x0`, `0x4`}. That grid has 4 intersections, but you only listed 3 bytes. The fourth byte, `0xA4`, would be falsely classified.

A quick sanity check: if the number of bytes in your class equals the number of unique high nibbles times the number of unique low nibbles, there are no false positives.

Let's look at both scalar and vectorized implementations below. You'll notice in the vectorized implementation, we still loop through the byte stream, but now 16 bytes at a time. And the inner body has no branches, just lookups and an `AND`.

```rs
// scalar implementation
enum Class {
    Comma = 1,
    Quote = 2,
    NewLine = 3,
    Other = 0,
}

let bytes: &[u8] = &data_stream;

let mut classified_bytes = Vec::with_capacity(bytes.len());

for b in bytes {
    let class = match b {
        0x2c => Class::Comma,
        0x22 => Class::Quote,
        0x0A | 0x0D => Class::NewLine,
        _ => Class::Other
    };

    classified_bytes.push(class);
}
```

The `v*` functions below are [NEON intrinsics](https://doc.rust-lang.org/core/arch/aarch64/index.html), thin wrappers around single ARM instructions that let you use SIMD from Rust without writing assembly.

```rs
// vectorized implementation
// i'm on a mac :/
use std::arch::aarch64::*;

const COMMA: u8 = Class::Comma as u8;
const QUOTE: u8 = Class::Quote as u8;
const NEWLINE: u8 = Class::NewLine as u8;

const LO_LOOKUP: [u8; 16] = {
    let mut t = [0u8; 16];
    t[0x2] = QUOTE;
    t[0xA] = NEWLINE;
    t[0xC] = COMMA;
    t[0xD] = NEWLINE;
    t
};

const HI_LOOKUP: [u8; 16] = {
    let mut t = [0u8; 16];
    t[0x0] = NEWLINE;
    t[0x2] = COMMA | QUOTE;
    t
};

let bytes: &[u8] = &data_stream;
let mut classified_bytes = Vec::with_capacity(bytes.len());

unsafe {
    // load 16 bytes into register
    let lo_lut = vld1q_u8(LO_LOOKUP.as_ptr());
    let hi_lut = vld1q_u8(HI_LOOKUP.as_ptr());
    // broadcast 0x0F to all 16 lanes
    let mask = vdupq_n_u8(0x0F);

    let chunks = bytes.chunks_exact(16);
    let remainder = chunks.remainder();

    for chunk in chunks {
        let input = vld1q_u8(chunk.as_ptr());

        // bitwise AND, isolate low nibble
        let lo_nibbles = vandq_u8(input, mask);
        // shift right 4, isolate high nibble
        let hi_nibbles = vandq_u8(vshrq_n_u8::<4>(input), mask);

        // table lookup by low nibble
        let lo_result = vqtbl1q_u8(lo_lut, lo_nibbles);
        // table lookup by high nibble
        let hi_result = vqtbl1q_u8(hi_lut, hi_nibbles);

        // AND to get final class
        let classified = vandq_u8(lo_result, hi_result);

        let mut out = [0u8; 16];
        // store 16 bytes from register
        vst1q_u8(out.as_mut_ptr(), classified);
        classified_bytes.extend_from_slice(&out);
    }

    // pad remaining bytes with zeros
    if !remainder.is_empty() {
        let mut padded = [0u8; 16];
        padded[..remainder.len()].copy_from_slice(remainder);

        let input = vld1q_u8(padded.as_ptr());

        let lo_nibbles = vandq_u8(input, mask);
        let hi_nibbles = vandq_u8(vshrq_n_u8::<4>(input), mask);

        let lo_result = vqtbl1q_u8(lo_lut, lo_nibbles);
        let hi_result = vqtbl1q_u8(hi_lut, hi_nibbles);

        let classified = vandq_u8(lo_result, hi_result);

        let mut out = [0u8; 16];
        vst1q_u8(out.as_mut_ptr(), classified);
        classified_bytes.extend_from_slice(&out[..remainder.len()]);
    }
}
```

## Step 1.5: Bitmasking

Now that we've classified every byte in the stream, we compress the classified bytes into 3 bitmasks, one per class. Each bit in a bitmask corresponds to a position in the byte stream: 1 if that class is present, 0 otherwise.

Take `alice,30,Irvine\n` (conveniently 16 bytes):

<pre class="csv-raw"><strong>Raw bytes:</strong>    a  l  i  c  e  <span class="sc-comma">,</span>  3  0  <span class="sc-comma">,</span>  I  r  v  i  n  e  <span class="sc-newline">\n</span>
<strong>Classified:</strong>   0  0  0  0  0  <span class="sc-comma">1</span>  0  0  <span class="sc-comma">1</span>  0  0  0  0  0  0  <span class="sc-newline">3</span>
<strong>COMMA mask:</strong>   0  0  0  0  0  <span class="sc-comma">1</span>  0  0  <span class="sc-comma">1</span>  0  0  0  0  0  0  0
<strong>QUOTE mask:</strong>   0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0
<strong>NEWLINE mask:</strong> 0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  <span class="sc-newline">1</span></pre>

Each class's bitmask is compactly represented as a `Vec<u64>`, meaning a single `u64` represents 64 bytes of the stream.

## Step 2: Filtering out "fake" structural characters

At this point, the classifier doesn't know the difference between a real delimiter and one inside a quoted field. Take the third row from our example:

<pre class="csv-raw">lonely charlie<span class="sc-comma">,</span>28<span class="sc-comma">,</span><span class="sc-quote">"</span>where she said<span class="sc-comma">,</span> <span class="sc-quote">""</span>hi<span class="sc-quote">""</span><span class="sc-newline">\n</span>to me<span class="sc-quote">"</span></pre>

The classifier flagged every structural character in the third field `"where she said, ""hi""\nto me"`. That includes a comma, a newline, and 6 quotes. The first and last quotes are real boundaries that separate the inside of a quoted field from the outside.

We can determine whether a position is inside or outside a quoted field by maintaining a running parity over the quote positions. If the number of quotes before a given position is even, it's outside. If it's odd, it's inside.

Applied to our example, everything between the first and last quote is inside the quoted field (shown in green). Notice that escaped quotes (`""`) are just 2 flips back to back. They cancel out, so the algorithm doesn't need to distinguish them from real boundaries.

<pre class="csv-raw walkthrough-target"><span data-byte="0">"</span><span class="sc-inside" data-byte="1">w</span><span class="sc-inside" data-byte="2">h</span><span class="sc-inside" data-byte="3">e</span><span class="sc-inside" data-byte="4">r</span><span class="sc-inside" data-byte="5">e</span><span class="sc-inside" data-byte="6"> </span><span class="sc-inside" data-byte="7">s</span><span class="sc-inside" data-byte="8">h</span><span class="sc-inside" data-byte="9">e</span><span class="sc-inside" data-byte="10"> </span><span class="sc-inside" data-byte="11">s</span><span class="sc-inside" data-byte="12">a</span><span class="sc-inside" data-byte="13">i</span><span class="sc-inside" data-byte="14">d</span><span class="sc-inside" data-byte="15">,</span><span class="sc-inside" data-byte="16"> </span><span data-byte="17">"</span><span class="sc-inside" data-byte="18">"</span><span class="sc-inside" data-byte="19">h</span><span class="sc-inside" data-byte="20">i</span><span data-byte="21">"</span><span class="sc-inside" data-byte="22">"</span><span class="sc-inside" data-byte="23">\n</span><span class="sc-inside" data-byte="24">t</span><span class="sc-inside" data-byte="25">o</span><span class="sc-inside" data-byte="26"> </span><span class="sc-inside" data-byte="27">m</span><span class="sc-inside" data-byte="28">e</span><span data-byte="29">"</span></pre>

<details>
<summary>Walk through the example (hover over each line)</summary>

<p class="walkthrough-line" data-bytes="0-0">byte 0 is <code>"</code> (quote count = 1, odd → inside)</p>

<p class="walkthrough-line" data-bytes="1-16">bytes 1-16 <code>where she said, </code> are inside</p>

<p class="walkthrough-line" data-bytes="17-17">byte 17 is <code>"</code> (quote count = 2, even → outside)</p>

<p class="walkthrough-line" data-bytes="18-18">byte 18 is <code>"</code> (quote count = 3, odd → inside)</p>

<p class="walkthrough-line" data-bytes="19-20">bytes 19-20 <code>hi</code> are inside</p>

<p class="walkthrough-line" data-bytes="21-21">byte 21 is <code>"</code> (quote count = 4, even → outside)</p>

<p class="walkthrough-line" data-bytes="22-22">byte 22 is <code>"</code> (quote count = 5, odd → inside)</p>

<p class="walkthrough-line" data-bytes="23-23">byte 23 <code>\n</code> is inside</p>

<p class="walkthrough-line" data-bytes="24-28">bytes 24-28 <code>to me</code> are inside</p>

<p class="walkthrough-line" data-bytes="29-29">byte 29 is <code>"</code> (quote count = 6, even → outside)</p>

</details>
<br>

{{< hover-image src="/images/weezer.jpg" alt="weezer" width="325" caption="How I felt when I learned about this" >}}To compute this across the entire byte stream in one pass, we can take the prefix XOR of the quote bitmask.{{< /hover-image >}} At each position, the result is the XOR of every quote bit up to and including that position.

<div class="prefix-hover-container">
<pre class="csv-raw">        "where she said, ""hi""\nto me"
<strong>quotes:</strong> 100000000000000001100110000001
<strong>prefix:</strong> 11111111111111111<span class="prefix-hl">01</span>11<span class="prefix-hl">01</span>1111110</pre>

<span class="prefix-hover-trigger">You'll notice that escaped quote pairs (`""`) produce alternating `01` in the prefix mask.</span> This is fine because we only use the prefix mask to filter commas and newlines, not quotes themselves. We invert the prefix to get an outside mask and `AND` it with the comma and newline bitmasks. This way, commas and newlines inside a quoted field get zeroed out, leaving only the real delimiters.

</div>

<pre class="csv-raw">            "where she said, ""hi""\nto me"
<strong>prefix:</strong>     111111111111111110111011111110
<strong>!prefix:</strong>    000000000000000001000100000001

<strong>commas:</strong>     000000000000000100000000000000
<strong>!prefix:</strong>    000000000000000001000100000001
<strong>& result:</strong>   000000000000000<span class="sc-comma-text">0</span>00000000000000

<strong>newlines:</strong>   000000000000000000000001000000
<strong>!prefix:</strong>    000000000000000001000100000001
<strong>& result:</strong>   00000000000000000000000<span class="sc-newline-text">0</span>000000</pre>

Computing a prefix XOR across 64 bits can be done with a chain of shifts in 6 operations, or with a single `vmull_p64` (carryless multiplication) instruction on `ARM`:

```rs
// shift-XOR chain: 6 operations
fn prefix_xor(mut x: u64) -> u64 {
    x ^= x >> 1;
    x ^= x >> 2;
    x ^= x >> 4;
    x ^= x >> 8;
    x ^= x >> 16;
    x ^= x >> 32;
    x
}
```

```rs
// carryless multiplication: 1 instruction
use std::arch::aarch64::vmull_p64;

fn prefix_xor(x: u64) -> u64 {
    unsafe { vmull_p64(x, u64::MAX) as u64 }
}
```

## Step 3: Collecting field and row boundaries

Now that our comma and newline bitmasks only contain real delimiters, we iterate through them one `u64` at a time.

We carry a single boolean between chunks that tracks whether we ended inside a quoted field. If the previous `u64` had an odd number of quote bits, we're still inside, and the prefix XOR for the current chunk needs to be inverted.

From the cleaned bitmasks, we extract delimiter positions by counting leading zeros (`clz`), a single-cycle instruction on most architectures. Each count gives us the offset of the next set bit, which is the next delimiter. If a newline appears before the next comma, it marks the end of both the current field and the current row.

```rs
type FieldRef = Range<usize>;
type RowRef = Vec<FieldRef>;

let mut rows = Vec::new();
let mut current_row = Vec::new();
let mut start = 0;
let mut end = 0;
let mut carry = false;

for i in 0..quote_bitsets.len() {
    let quotes = quote_bitsets[i];
    let outside = !prefix_xor(quotes, carry);

    // a branchless way of toggling carry
    // when the chunk has an odd number of quotes
    carry ^= (quotes.count_ones() & 1) != 0;

    let mut commas = comma_bitsets[i] & outside;
    let mut newlines = newline_bitsets[i] & outside;

    loop {
        let next_comma = commas.leading_zeros() as usize;
        let next_newline = newlines.leading_zeros() as usize;
        let advance = next_comma.min(next_newline);

        // no delimiters seen in this chunk
        if advance == 64 {
            end = (i + 1) * 64;
            break;
        }

        end += advance;

        if start < end {
            current_row.push(start..end);

            if next_newline < next_comma {
                rows.push(current_row.clone());
                current_row.clear();
            }
        }

        // skip the delimiter
        end += 1;

        // shift out the bits we already processed
        commas <<= advance + 1;
        newlines <<= advance + 1;
        start = end;
    }
}
```
