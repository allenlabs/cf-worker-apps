interface Props {
  html: string;
  className?: string;
}

export function Markdown({ html, className }: Props) {
  return (
    <div
      className={`markdown ${className ?? ''}`}
      // server already sanitised
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
