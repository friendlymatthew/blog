---
title: "Parsing JSON on the GPU using prefix scans as I struggle with my mid 20s"
description: ""
date: 2026-10-23
draft: false
tags: ["rust", "parallelism", "gpu", "json", "file formats"]
categories: ["programming"]
---

Ever since I discovered SIMD instructions, I've been chasing a more potent high of parallelism. It was only a matter of time till I started injecting GPU threads into my veins.

This summer, while I sweltered through a Parisian heatwave, I wrote a JSON parser that runs entirely on the GPU.

Parsing in general looks inherently sequential. Every byte you consume updates some state that the next byte depends on, so no byte can be understood in isolation. But in this post, I'll explain how parsing JSON breaks down into a series of maps and prefix scans, operations a GPU can run in parallel. 

A note: a lot of concepts that we'll go over in this blog post was shared by Raph Levien. At the bottom, I will link all of the reading I had to do, it is worth studying.


# SIMT vs SIMD 

Shaders (programs that run on the GPU) follow an execution model called SIMT, [single instruction, multiple threads](https://en.wikipedia.org/wiki/Single_instruction,_multiple_threads). You write a shader from the point of view of a single thread, and the GPU runs thousands of copies of it at once. Each thread gets its own index, which it uses to decide what section of data to work on.

This is quite the shift from writing vectorized code (code with SIMD instructions). SIMD instructions are just specialized CPU instructions. Meaning your ordinary code can interleave with vectorized code at a minor cost of packing data to and from SIMD registers.

The following snippets mark which bytes in a buffer are quotes (`"`), writing a 1 for each quote and a 0 for everything else. 

```rust
#![feature(portable_simd)]
use std::simd::prelude::*;

fn mark_quotes(input: &[u8], out: &mut [u8]) {
    let (in_chunks, in_tail) = input.as_chunks::<16>();
    let (out_chunks, out_tail) = out.as_chunks_mut::<16>();

    let quote = u8x16::splat(b'"');

    for (src, dst) in in_chunks.iter().zip(out_chunks) {
        let bytes = u8x16::from_array(*src);
        let mask = bytes.simd_eq(quote);
        *dst = mask.select(u8x16::splat(1), u8x16::splat(0)).to_array();
    }

    for (src, dst) in in_tail.iter().zip(out_tail) {
        *dst = (*src == b'"') as u8;
    }
}
```

A shader has no ordinary code to return to. The entire program is written from the point of view of one thread, which only knows its own index.

```wgsl
const QUOTE: u32 = 0x22u; // '"'

@group(0) @binding(0) var<storage, read> input: array<u32>; // one byte per u32
@group(0) @binding(1) var<storage, read_write> out: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i >= arrayLength(&input)) {
        return;
    }

    if (input[i] == QUOTE) {
        out[i] = 1u;
    } else {
        out[i] = 0u;
    }
}
```

# How threads talk to each other and the Hillis-Steele algorithm

Great, so a shader is code written for a single thread and the GPU runs copies of it in parallel. The snippet above shows how each thread can check its own byte in isolation. But for problems like parsing, this can only get you so far. A thread can tell that its byte is a quote, but not whether that quote opens or closes a string, because that depends on every byte before it. And since each of those bytes belong to a different thread, threads need a way to talk to each other.

One common technique to communicate across threads is the prefix scan. You may have heard of its most popular child, the prefix sum. But a prefix scan works with any binary associative operator, so its other pimply children use max, xor, or even function composition.

After a prefix scan, each thread holds the combined result of every element up to and including its own. 

The following example is just plain old prefix sum or prefix scan with the sum operator.

```rust

// input: [3, 1, 4, 1, 5]
// output [3, 4, 8, 9, 14]
fn prefix_sum(input: &[i32]) -> Vec<i32> {
    let mut curr = 0i32;

    input
        .iter()
        .map(|&x| {
            curr += x;
            curr
        })
        .collect::<Vec<_>>()
}
```

If we did the following in shader code, that is having a running total `curr`, we would lose the parallelism and every thread would sit and wait for its left neighbor. 

The trick is to stop waiting for the running total and build it up in rounds instead. In each round, every thread adds the value `stride` positions to its left, and the stride doubles every round. Threads with nothing that far to their left keep their value.
