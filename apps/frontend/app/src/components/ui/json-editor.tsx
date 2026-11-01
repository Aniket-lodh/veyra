// JSON body editor — CodeMirror 6 with highlight, lint gutter, and Beautify.
// Same role as Postman/Insomnia's JSON body pane: edit a payload string.
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo, useState } from 'react';

const extensions = [
  json(),
  lintGutter(),
  // Empty body is valid (no payload). Only lint when there is content.
  linter((view) => {
    if (view.state.doc.toString().trim() === '') return [];
    return jsonParseLinter()(view);
  }),
  EditorView.theme({
    '&': {
      fontSize: '0.8125rem',
      backgroundColor: 'transparent',
    },
    '.cm-content': {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      padding: '0.5rem 0',
      caretColor: 'var(--foreground)',
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
    '.cm-scroller': {
      overflow: 'auto',
    },
  }),
  EditorView.lineWrapping,
];

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  minHeight?: string;
  'aria-label'?: string;
}

export function JsonEditor({
  value,
  onChange,
  placeholder = '{\n  \n}',
  className,
  minHeight = '160px',
  'aria-label': ariaLabel = 'JSON body',
}: JsonEditorProps) {
  const [beautifyError, setBeautifyError] = useState<string | null>(null);

  const status = useMemo(() => jsonStatus(value), [value]);

  const beautify = () => {
    const trimmed = value.trim();
    if (trimmed === '') {
      setBeautifyError(null);
      return;
    }
    try {
      onChange(JSON.stringify(JSON.parse(trimmed), null, 2) + '\n');
      setBeautifyError(null);
    } catch (e) {
      setBeautifyError((e as Error).message || 'Invalid JSON');
    }
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[0.6875rem] font-medium tracking-wide uppercase">
            JSON
          </span>
          {status === 'invalid' && (
            <span className="text-destructive text-[0.6875rem]">
              Invalid JSON
            </span>
          )}
          {status === 'valid' && (
            <span className="text-[0.6875rem] text-emerald-700">Valid</span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={beautify}
          disabled={value.trim() === ''}
        >
          Beautify
        </Button>
      </div>

      <div
        className={cn(
          'border-border overflow-hidden rounded-md border bg-transparent',
          'focus-within:border-ring focus-within:ring-ring/30 focus-within:ring-2',
          status === 'invalid' && 'border-destructive/50',
        )}
      >
        <CodeMirror
          value={value}
          height={minHeight}
          theme="light"
          placeholder={placeholder}
          extensions={extensions}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: false,
            bracketMatching: true,
            autocompletion: false,
            searchKeymap: false,
          }}
          onChange={(v) => {
            setBeautifyError(null);
            onChange(v);
          }}
          aria-label={ariaLabel}
        />
      </div>

      {beautifyError && (
        <p className="text-destructive text-[0.6875rem]" role="status">
          Cannot beautify: {beautifyError}
        </p>
      )}
    </div>
  );
}

function jsonStatus(value: string): 'empty' | 'valid' | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') return 'empty';
  try {
    JSON.parse(trimmed);
    return 'valid';
  } catch {
    return 'invalid';
  }
}
