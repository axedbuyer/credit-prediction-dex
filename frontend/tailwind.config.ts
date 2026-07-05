import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        'surface-1': 'var(--color-surface-1)',
        'surface-2': 'var(--color-surface-2)',
        'surface-3': 'var(--color-surface-3)',
        dim: 'var(--color-dim)',
        teal: {
          DEFAULT: 'var(--color-teal)',
          a10: 'var(--color-teal-a10)',
          a16: 'var(--color-teal-a16)',
          a22: 'var(--color-teal-a22)',
          a32: 'var(--color-teal-a32)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
          a10: 'var(--color-danger-a10)',
          a28: 'var(--color-danger-a28)',
        },
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        'text-1': 'var(--color-text-1)',
        'text-2': 'var(--color-text-2)',
        'text-muted': 'var(--color-text-muted)',
      },
      borderColor: {
        subtle: 'var(--border-subtle)',
        brand: 'var(--border-brand)',
        'brand-em': 'var(--border-brand-em)',
      },
      fontFamily: {
        sans: ['var(--font-barlow)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-eb-garamond)', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
}

export default config
