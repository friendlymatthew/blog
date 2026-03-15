import { test, expect } from 'playwright/test';

test.describe('hover-image popup — mobile', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'desktop-chrome');
    await page.goto('/about/');
    await page.waitForLoadState('networkidle');
  });

  test('tap shows popup', async ({ page }) => {
    const trigger = page.locator('.hover-image-trigger').first();
    const popup = trigger.locator('.hover-image-popup');

    await expect(popup).toHaveCSS('opacity', '0');
    await trigger.tap();
    await expect(popup).toHaveCSS('opacity', '1');
  });

  test('tap again dismisses popup', async ({ page }) => {
    const trigger = page.locator('.hover-image-trigger').first();
    const popup = trigger.locator('.hover-image-popup');

    await trigger.tap();
    await expect(popup).toHaveCSS('opacity', '1');

    await trigger.tap();
    await expect(popup).toHaveCSS('opacity', '0');
  });

  test('tap elsewhere dismisses popup', async ({ page }) => {
    const trigger = page.locator('.hover-image-trigger').first();
    const popup = trigger.locator('.hover-image-popup');

    await trigger.tap();
    await expect(popup).toHaveCSS('opacity', '1');

    await page.tap('body', { position: { x: 200, y: 10 } });
    await expect(popup).toHaveCSS('opacity', '0');
  });

  test('scroll dismisses popup', async ({ page }) => {
    const trigger = page.locator('.hover-image-trigger').first();
    const popup = trigger.locator('.hover-image-popup');

    await trigger.tap();
    await expect(popup).toHaveCSS('opacity', '1');

    await page.evaluate(() => window.scrollBy(0, 50));
    await expect(popup).toHaveCSS('opacity', '0');
  });

  test('micro-scroll during tap does not prevent popup', async ({ page }) => {
    const trigger = page.locator('.hover-image-trigger').first();
    const popup = trigger.locator('.hover-image-popup');

    const box = await trigger.boundingBox();
    await page.evaluate(
      async ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        el.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            touches: [
              new Touch({ identifier: 1, target: el, clientX: x, clientY: y }),
            ],
          })
        );
        await new Promise((r) => setTimeout(r, 50));
        window.scrollBy(0, 2);
        await new Promise((r) => setTimeout(r, 50));
        el.dispatchEvent(
          new TouchEvent('touchend', {
            bubbles: true,
            changedTouches: [
              new Touch({ identifier: 1, target: el, clientX: x, clientY: y }),
            ],
          })
        );
        el.click();
      },
      { x: box.x + 10, y: box.y + 5 }
    );

    await expect(popup).toHaveCSS('opacity', '1');
  });
});

test.describe('hover-image popup — desktop', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-chrome');
    await page.goto('/about/');
    await page.waitForLoadState('networkidle');
  });

  test('hover shows popup', async ({ page }) => {
    const trigger = page.locator('.hover-image-trigger').first();
    const popup = trigger.locator('.hover-image-popup');

    await expect(popup).toHaveCSS('opacity', '0');
    await trigger.hover();
    await expect(popup).toHaveCSS('opacity', '1');
  });

  test('moving mouse away hides popup', async ({ page }) => {
    const trigger = page.locator('.hover-image-trigger').first();
    const popup = trigger.locator('.hover-image-popup');

    await trigger.hover();
    await expect(popup).toHaveCSS('opacity', '1');

    await page.mouse.move(0, 0);
    await expect(popup).toHaveCSS('opacity', '0');
  });
});
