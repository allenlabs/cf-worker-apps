export type TextArtifactRef = {
  id: string; sha256: string; chars: number; bytes: number; startCursor: string;
};

/** `content` is a fragment of the original text; concatenate through eof before parsing JSON. */
export type TextArtifactPage = {
  artifactId: string; sha256: string; totalChars: number; totalBytes: number;
  cursor: string; start: number; end: number; content: string;
  nextCursor: string | null; eof: boolean;
};

export type ChatRecordPage = {
  sequence: number | null;
  nextSequence: number | null;
  page: TextArtifactPage | null;
};
