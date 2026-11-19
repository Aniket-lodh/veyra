import type { ThemeContextValue } from './types';
import { createContext } from 'react';

export const ThemeContext = createContext<ThemeContextValue | null>(null);
