/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Neutral gray scale — no blue/navy tint, keeps the brand reading as white + teal + orange
        ink: {
          50: '#f7f7f7',
          100: '#ededed',
          200: '#d9d9d9',
          300: '#b8b8b8',
          400: '#8c8c8c',
          500: '#6b6b6b',
          600: '#525252',
          700: '#3d3d3d',
          800: '#262626',
          900: '#171717',
          950: '#0a0a0a',
        },
        // Brand accents: teal (primary) + orange (secondary), white-dominant surfaces
        ledger: {
          paper: '#ffffff',
          line: '#e5e5e5',
          stamp: '#0f8c82',
          stampDark: '#0b6d65',
          brick: '#d64545',
          amber: '#f2711c',
        },
      },
      fontFamily: {
        display: ['"Fraunces"', 'serif'],
        body: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        'paper-fiber':
          "radial-gradient(circle at 1px 1px, rgba(18,35,61,0.035) 1px, transparent 0)",
      },
      backgroundSize: {
        fiber: '18px 18px',
      },
      boxShadow: {
        stub: '0 1px 0 0 rgba(18,35,61,0.06), 0 8px 24px -12px rgba(18,35,61,0.18)',
      },
    },
  },
  plugins: [],
}
