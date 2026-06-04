import { describe, expect, it } from 'vitest';
import { isStaticAssetPath } from '~/lib/public-paths';

describe('isStaticAssetPath', () => {
  it('matches hashed build assets under /assets/', () => {
    expect(isStaticAssetPath('/assets/app-rSus-5yl.css')).toBe(true);
    expect(isStaticAssetPath('/assets/router-Dqa6HTWu.js')).toBe(true);
  });

  it('matches static file extensions anywhere', () => {
    for (const p of ['/favicon.svg', '/robots.txt', '/x/y/font.woff2', '/a.css.map', '/icon.png']) {
      expect(isStaticAssetPath(p)).toBe(true);
    }
  });

  it('does NOT match app routes', () => {
    for (const p of ['/', '/projects', '/projects/acme/issues', '/my/page', '/notifications', '/auth/login']) {
      expect(isStaticAssetPath(p)).toBe(false);
    }
  });
});
