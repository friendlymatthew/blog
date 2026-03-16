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
  
  // Page load time display
  if (window.performance) {
    const loadTime = (performance.now() / 1000).toFixed(2);
    const timeElement = document.querySelector('.page-load-time');
    if (timeElement) {
      timeElement.textContent = `Page loaded in ${loadTime}s`;
    }
  }
  
});

