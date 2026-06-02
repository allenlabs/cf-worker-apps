import { describe, expect, it } from 'vitest';
import { normalizeEmbed, isBareUrl, isAutoEmbedUrl } from '../src/lib/embed';

describe('normalizeEmbed — YouTube', () => {
  it('rewrites a watch URL to the embed form', () => {
    expect(normalizeEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      provider: 'youtube',
    });
  });

  it('rewrites a youtu.be short link', () => {
    expect(normalizeEmbed('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      provider: 'youtube',
    });
  });

  it('handles /shorts/ and existing /embed/ paths', () => {
    expect(normalizeEmbed('https://youtube.com/shorts/abc123')?.embedUrl).toBe(
      'https://www.youtube.com/embed/abc123',
    );
    expect(normalizeEmbed('https://www.youtube.com/embed/abc123')?.embedUrl).toBe(
      'https://www.youtube.com/embed/abc123',
    );
  });
});

describe('normalizeEmbed — Vimeo', () => {
  it('rewrites a vimeo.com/<id> URL to the player form', () => {
    expect(normalizeEmbed('https://vimeo.com/123456789')).toEqual({
      embedUrl: 'https://player.vimeo.com/video/123456789',
      provider: 'vimeo',
    });
  });

  it('passes a player.vimeo.com URL through', () => {
    const r = normalizeEmbed('https://player.vimeo.com/video/123456789');
    expect(r?.provider).toBe('vimeo');
    expect(r?.embedUrl).toContain('player.vimeo.com/video/123456789');
  });
});

describe('normalizeEmbed — Figma', () => {
  it('wraps a figma file URL in the official embed', () => {
    const r = normalizeEmbed('https://www.figma.com/file/abc/My-Design');
    expect(r?.provider).toBe('figma');
    expect(r?.embedUrl).toContain('https://www.figma.com/embed');
    expect(r?.embedUrl).toContain('url=');
  });

  it('handles /design/ and /proto/ URLs', () => {
    expect(normalizeEmbed('https://figma.com/design/xyz/Foo')?.provider).toBe('figma');
    expect(normalizeEmbed('https://figma.com/proto/xyz/Foo')?.provider).toBe('figma');
  });
});

describe('normalizeEmbed — Google Maps + generic', () => {
  it('adds output=embed to a maps URL', () => {
    const r = normalizeEmbed('https://www.google.com/maps/place/Somewhere');
    expect(r?.provider).toBe('googlemaps');
    expect(r?.embedUrl).toContain('output=embed');
  });

  it('passes an arbitrary URL through as generic', () => {
    expect(normalizeEmbed('https://example.com/page')).toEqual({
      embedUrl: 'https://example.com/page',
      provider: 'generic',
    });
  });

  it('rejects non-http(s) and malformed input', () => {
    expect(normalizeEmbed('not a url')).toBeNull();
    expect(normalizeEmbed('javascript:alert(1)')).toBeNull();
    expect(normalizeEmbed('ftp://example.com')).toBeNull();
    expect(normalizeEmbed('')).toBeNull();
  });
});

describe('isBareUrl', () => {
  it('accepts a lone http(s) URL', () => {
    expect(isBareUrl('https://example.com')).toBe(true);
    expect(isBareUrl('  https://example.com  ')).toBe(true);
  });

  it('rejects URLs with surrounding text or whitespace', () => {
    expect(isBareUrl('see https://example.com')).toBe(false);
    expect(isBareUrl('https://a.com https://b.com')).toBe(false);
    expect(isBareUrl('plain text')).toBe(false);
  });
});

describe('isAutoEmbedUrl', () => {
  it('is true for bare YouTube/Vimeo/Figma URLs', () => {
    expect(isAutoEmbedUrl('https://youtu.be/abc')).toBe(true);
    expect(isAutoEmbedUrl('https://vimeo.com/123')).toBe(true);
    expect(isAutoEmbedUrl('https://www.figma.com/file/x/Y')).toBe(true);
  });

  it('is false for generic URLs (so ordinary links still paste as links)', () => {
    expect(isAutoEmbedUrl('https://example.com')).toBe(false);
    expect(isAutoEmbedUrl('https://www.google.com/maps/x')).toBe(false);
  });

  it('is false for non-bare input', () => {
    expect(isAutoEmbedUrl('watch https://youtu.be/abc')).toBe(false);
  });
});
