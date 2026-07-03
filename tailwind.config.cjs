/** Sunny design tokens — dark theme, warm amber accent (matches the mockup). */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // App chrome — deep charcoal-navy, darkest at the base.
        ink: {
          950: '#0a0d13', // app background
          900: '#0e121a', // sidebar / rails
          850: '#12161f', // panels
          800: '#171c27', // cards
          750: '#1d2330', // hover / elevated
          700: '#262d3b', // borders
          600: '#323a4b'
        },
        // Warm amber accent system.
        amber: {
          DEFAULT: '#f5a623',
          50: '#fdf2dc',
          100: '#fbe3b3',
          300: '#f7c25a',
          400: '#f5a623',
          500: '#e8951a',
          soft: '#f5c469', // lighter peach used on the send button
          dim: '#3a2e16' // amber tint for subtle fills
        },
        // Foreground text.
        fg: {
          DEFAULT: '#e8eaf0',
          muted: '#9aa3b4',
          subtle: '#6b7385',
          heading: '#dfe3f0'
        },
        // Status accents for the activity feed / badges.
        status: {
          success: '#34d399',
          working: '#f5a623',
          blocked: '#f87171',
          queued: '#60a5fa',
          info: '#a78bfa'
        }
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace']
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
        '3xl': '1.5rem'
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(245,166,35,0.4), 0 8px 30px -8px rgba(245,166,35,0.35)',
        panel: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)'
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' }
        }
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
