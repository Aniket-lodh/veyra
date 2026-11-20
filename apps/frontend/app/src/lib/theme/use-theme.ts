import { ThemeContext } from './theme-context';
import type { ThemeContextValue } from './types';
import { useContext } from 'react';

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
