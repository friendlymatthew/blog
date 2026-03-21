/* Japanese Web Aesthetic Theme — Optional JavaScript for enhanced functionality */
document.addEventListener('DOMContentLoaded', function() {
  
  // Sequential quote rotation from config
  const quoteContainer = document.querySelector('.quote-rotation');
  if (quoteContainer) {
    const quotes = JSON.parse(quoteContainer.getAttribute('data-quotes'));
    if (quotes && quotes.length > 0) {
      const idx = parseInt(localStorage.getItem('hugo_quote_idx') || '0') % quotes.length;
      const quote = quotes[idx];
      localStorage.setItem('hugo_quote_idx', ((idx + 1) % quotes.length).toString());
      const quoteElement = document.querySelector('.random-quote p');
      if (quoteElement) {
        quoteElement.textContent = quote.text;
        const citeElement = document.querySelector('.random-quote cite');
        if (citeElement) {
          citeElement.textContent = `— ${quote.author}`;
        }
      }
    }
  }
  
  // Walkthrough byte highlighting
  document.querySelectorAll('.walkthrough-line').forEach(function(line) {
    var range = line.getAttribute('data-bytes').split('-');
    var start = parseInt(range[0]);
    var end = parseInt(range[1]);

    line.addEventListener('mouseenter', function() {
      for (var i = start; i <= end; i++) {
        var el = document.querySelector('.walkthrough-target [data-byte="' + i + '"]');
        if (el) el.classList.add('byte-hl');
      }
    });

    line.addEventListener('mouseleave', function() {
      for (var i = start; i <= end; i++) {
        var el = document.querySelector('.walkthrough-target [data-byte="' + i + '"]');
        if (el) el.classList.remove('byte-hl');
      }
    });
  });

  // On mobile, open links in same tab instead of new tab
  if (window.innerWidth <= 600) {
    document.querySelectorAll('a[target="_blank"]').forEach(function(a) {
      a.removeAttribute('target');
    });
  }

  // Page load time display
  if (window.performance) {
    const loadTime = (performance.now() / 1000).toFixed(2);
    const timeElement = document.querySelector('.page-load-time');
    if (timeElement) {
      timeElement.textContent = `Page loaded in ${loadTime}s`;
    }
  }
  
});

