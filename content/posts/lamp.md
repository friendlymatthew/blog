---
title: "Lamp: a pull-cord lamp for your menu bar"
description: "A tiny macOS menu bar app that warms and dims your screen when you pull its cord"
date: 2026-10-12
draft: false
tags: ["macos", "swift"]
categories: ["programming"]
---

Lamp is a little banker's lamp that lives in your Mac's menu bar. Grab the cord, pull it down, and it clicks. Your screen goes warm. Pull again and it warms and dims. Pull a third time and it's off.

<div class="post-image-centered">
<img src="/images/lamp-icons.png" alt="The Lamp menu bar icon: off, warm, and warm + dim, on dark and light menu bars" />
</div>

Right-click the lamp to pick how warm (Candle, Sunset, Desk lamp) and how dim (Gentle, Medium, Deep) it gets, or to have it open at login.

# Download

<p style="text-align: center; font-size: 1.2em;"><a href="/downloads/Lamp.dmg" download><strong>Download Lamp.dmg</strong></a></p>

It needs macOS 13 or later and runs on both Apple Silicon and Intel Macs.

# Installing

Open the DMG and drag Lamp into Applications.

Lamp isn't from the App Store and I haven't paid Apple to sign it, so the first time you open it macOS will say it can't verify the developer. To let it through:

1. Open Lamp and close the warning.
2. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Lamp.
3. Confirm, and the lamp shows up in your menu bar.

You only have to do this once. If you'd rather use Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Lamp.app
```
