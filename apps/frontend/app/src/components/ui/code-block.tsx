// Read-only code viewer. JSON uses the same CodeMirror highlighter as the
// enqueue body editor; plain text (stack traces, excerpts) stays unhighlighted.
import { cn } from '@/lib/utils';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo, useState } from 'react';

const viewerTheme = EditorView.theme({
  '&': {
    fontSize: '0.8125rem',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    padding: '0.5rem 0',
    caretColor: 'transparent',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '1px solid var(--border)',
    color: 'var(--muted-foreground)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor, .cm-dropCursor': {
    display: 'none',
  },
});

interface CodeBlockProps {
  /** The text to render. Callers still pass a string
   *  (e.g. JSON.stringify(value, null, 2)). */
  children: string;
  className?: string;
  /** `json` gets syntax highlighting; `text` is plain monospace. */
  language?: 'json' | 'text';
  /** Mark content that was already truncated upstream (e.g. a response
   *  excerpt capped by the worker). Shows a small note under the block. */
  truncated?: boolean;
  /** Override the default truncation note. */
  truncatedNote?: string;
  /** Start with soft-wrap on. Defaults to off (horizontal scroll). */
  defaultWrap?: boolean;
}

/**
 * CodeBlock — bounded scrollable viewer with copy + wrap controls.
 * JSON surfaces share highlighting with JsonEditor; stacks/excerpts stay plain.
 */
export function CodeBlock({
  children,
  className,
  language = 'text',
  truncated,
  truncatedNote,
  defaultWrap = false,
}: CodeBlockProps) {
  const [wrap, setWrap] = useState(defaultWrap);
  const [copied, setCopied] = useState(false);

  const extensions = useMemo(() => {
    const exts = [viewerTheme];
    if (language === 'json') exts.push(json());
    if (wrap) exts.push(EditorView.lineWrapping);
    return exts;
  }, [language, wrap]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable in insecure contexts — fail quietly.
    }
  };

  const btn =
    'border-border bg-background/80 text-muted-foreground hover:text-foreground rounded border px-1.5 py-0.5 text-[0.625rem] backdrop-blur-sm';

  return (
    <div className={cn('relative min-w-0', className)}>
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setWrap((w) => !w)}
          aria-pressed={wrap}
          className={btn}
          title={wrap ? 'Disable soft wrap' : 'Soft-wrap long lines'}
        >
          {wrap ? 'No wrap' : 'Wrap'}
        </button>
        <button
          type="button"
          onClick={onCopy}
          className={btn}
          title="Copy to clipboard"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {language === 'json' ? (
        <div className="bg-muted/40 border-border overflow-hidden rounded-md border">
          <CodeMirror
            value={children}
            maxHeight="20rem"
            theme="light"
            editable={false}
            readOnly
            extensions={extensions}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              bracketMatching: true,
              autocompletion: false,
              searchKeymap: false,
              dropCursor: false,
            }}
          />
        </div>
      ) : (
        <pre
          className={cn(
            'bg-muted/40 text-foreground border-border max-h-80 overflow-auto rounded-md border py-2 pr-3 pl-3 font-mono text-xs leading-relaxed',
            wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
          )}
        >
          {children}
        </pre>
      )}

      {truncated && (
        <p className="text-muted-foreground mt-1 text-[0.625rem]">
          {truncatedNote ??
            'Output was truncated upstream — showing the captured portion.'}
        </p>
      )}
    </div>
  );
}
