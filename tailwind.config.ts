import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: [ 'class', '[data-mode="dark"]' ],
  content: [
    './ui/admin/index.html',
    './ui/admin/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
      },
    },
  },
  plugins: [],
};

export default config;
