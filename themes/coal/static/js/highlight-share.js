(function () {
  var ROOT_SELECTOR = '.content';
  var HASH_PREFIX = '#h=';
  var btn = null;
  var hideTimer = null;

  function getRoot() {
    return document.querySelector(ROOT_SELECTOR);
  }

  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'highlight-share-btn';
    btn.textContent = 'Share';
    btn.style.display = 'none';
    document.body.appendChild(btn);
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', onShareClick);
    return btn;
  }

  function hideBtn() {
    if (btn) btn.style.display = 'none';
  }

  function showBtnAt(rect) {
    ensureBtn();
    btn.style.display = 'block';
    var bw = btn.offsetWidth;
    var bh = btn.offsetHeight;
    var centerX = rect.left + rect.width / 2;
    var top = rect.top - bh - 8;
    var left = centerX - bw / 2;
    if (top < 8) top = rect.bottom + 8;
    if (left < 8) left = 8;
    var maxLeft = document.documentElement.clientWidth - bw - 8;
    if (left > maxLeft) left = maxLeft;
    btn.style.top = top + 'px';
    btn.style.left = left + 'px';
  }

  function onShareClick() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var text = sel.toString();
    if (!text.trim()) return;
    var url = location.origin + location.pathname + location.search + HASH_PREFIX + encodeURIComponent(text);
    var done = function (ok) {
      btn.textContent = ok ? 'copied!' : 'failed';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        btn.textContent = 'Share';
        hideBtn();
        if (sel.removeAllRanges) sel.removeAllRanges();
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      done(ok);
    }
  }

  function selectionInRoot(sel) {
    if (!sel.rangeCount) return false;
    var root = getRoot();
    if (!root) return false;
    var r = sel.getRangeAt(0);
    return root.contains(r.startContainer) && root.contains(r.endContainer);
  }

  function maybeShow() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideBtn(); return; }
    if (!selectionInRoot(sel)) { hideBtn(); return; }
    if (!sel.toString().trim()) { hideBtn(); return; }
    var range = sel.getRangeAt(0);
    var rects = range.getClientRects();
    var rect = null;
    if (rects) {
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.width > 0 && r.height > 0) {
          if (!rect || r.top < rect.top) rect = r;
        }
      }
    }
    if (!rect) rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { hideBtn(); return; }
    showBtnAt(rect);
  }

  document.addEventListener('mouseup', function (e) {
    if (btn && (e.target === btn || btn.contains(e.target))) return;
    setTimeout(maybeShow, 0);
  });
  document.addEventListener('keyup', function () { setTimeout(maybeShow, 0); });
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideBtn();
  });
  document.addEventListener('mousedown', function (e) {
    if (btn && (e.target === btn || btn.contains(e.target))) return;
    hideBtn();
  });
  window.addEventListener('scroll', function () { hideBtn(); }, { passive: true });

  function normalize(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function isVisible(node) {
    var p = node.parentElement;
    while (p) {
      var s = window.getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      p = p.parentElement;
    }
    return true;
  }

  function findRange(root, target) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return isVisible(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var combined = '';
    var map = [];
    var needSpace = false;
    var n;
    while ((n = walker.nextNode())) {
      var text = n.nodeValue;
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (/\s/.test(ch)) {
          needSpace = true;
        } else {
          if (needSpace && combined.length > 0) {
            combined += ' ';
            map.push(null);
          }
          combined += ch;
          map.push({ node: n, offset: i });
          needSpace = false;
        }
      }
    }

    var tgt = normalize(target);
    if (!tgt) return null;
    var idx = combined.indexOf(tgt);
    if (idx < 0) return null;

    var startEntry = null;
    for (var a = idx; a < combined.length && !startEntry; a++) startEntry = map[a];
    var endEntry = null;
    for (var b = idx + tgt.length - 1; b >= 0 && !endEntry; b--) endEntry = map[b];
    if (!startEntry || !endEntry) return null;

    var range = document.createRange();
    range.setStart(startEntry.node, startEntry.offset);
    range.setEnd(endEntry.node, endEntry.offset + 1);
    return range;
  }

  function wrapRange(range) {
    var startNode = range.startContainer;
    var endNode = range.endContainer;
    var startOffset = range.startOffset;
    var endOffset = range.endOffset;

    if (startNode === endNode) {
      return [splitWrap(startNode, startOffset, endOffset)];
    }

    var walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, null);
    var inRange = [];
    var n;
    while ((n = walker.nextNode())) {
      if (range.intersectsNode(n)) inRange.push(n);
    }
    var marks = [];
    inRange.forEach(function (node) {
      var s = 0, e = node.nodeValue.length;
      if (node === startNode) s = startOffset;
      if (node === endNode) e = endOffset;
      if (s >= e) return;
      marks.push(splitWrap(node, s, e));
    });
    return marks;
  }

  function splitWrap(textNode, s, e) {
    var value = textNode.nodeValue;
    var before = value.slice(0, s);
    var mid = value.slice(s, e);
    var after = value.slice(e);
    var mark = document.createElement('mark');
    mark.className = 'highlight-link';
    mark.textContent = mid;
    var parent = textNode.parentNode;
    if (before) parent.insertBefore(document.createTextNode(before), textNode);
    parent.insertBefore(mark, textNode);
    if (after) parent.insertBefore(document.createTextNode(after), textNode);
    parent.removeChild(textNode);
    return mark;
  }

  function applyHashHighlight() {
    var hash = location.hash || '';
    if (hash.indexOf(HASH_PREFIX) !== 0) return;
    var target;
    try { target = decodeURIComponent(hash.slice(HASH_PREFIX.length)); } catch (e) { return; }
    if (!target) return;
    var root = getRoot();
    if (!root) return;
    var range = findRange(root, target);
    if (!range) return;
    var marks = wrapRange(range);
    var first = marks && marks[0];
    if (first && first.scrollIntoView) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // run after async math/font rendering settles
  function run() { setTimeout(applyHashHighlight, 50); }
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();
