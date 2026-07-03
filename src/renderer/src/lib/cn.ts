import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Compose conditional class names and de-conflict Tailwind utilities.
 * Last-writer-wins on conflicting Tailwind classes (e.g. `px-2` vs `px-4`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
