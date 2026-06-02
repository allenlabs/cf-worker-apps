import { describe, expect, it } from 'vitest';
import { formatFileSize, fileNameFromUrl } from '../src/extensions/media';

describe('formatFileSize', () => {
  it('formats bytes/KB/MB/GB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatFileSize(3 * 1024 * 1024 * 1024)).toBe('3 GB');
  });

  it('returns empty string for null/invalid', () => {
    expect(formatFileSize(null)).toBe('');
    expect(formatFileSize(undefined)).toBe('');
    expect(formatFileSize(-1)).toBe('');
    expect(formatFileSize(NaN)).toBe('');
  });
});

describe('fileNameFromUrl', () => {
  it('extracts the last path segment', () => {
    expect(fileNameFromUrl('https://cdn.example.com/files/report.pdf')).toBe('report.pdf');
    expect(fileNameFromUrl('https://cdn.example.com/a/b/c/notes.txt')).toBe('notes.txt');
  });

  it('decodes percent-encoded names', () => {
    expect(fileNameFromUrl('https://x.com/My%20File.pdf')).toBe('My File.pdf');
  });

  it('falls back to "File" when there is no segment', () => {
    expect(fileNameFromUrl('https://example.com/')).toBe('File');
    expect(fileNameFromUrl('not-a-url')).toBe('not-a-url');
    expect(fileNameFromUrl('')).toBe('File');
  });
});
