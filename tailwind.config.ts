import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f9f8f6',
        surface: '#ffffff',
        surface2: '#f4f3f0',
        border: '#e8e6e1',
        border2: '#d5d2cb',
        text: {
          DEFAULT: '#1a1915',
          2: '#6b6860',
          3: '#a8a49c',
        },
        accent: {
          DEFAULT: '#c96442',
          s: '#f0ebe4',
          b: '#e8d8cc',
        },
        green: {
          DEFAULT: '#3d7a56',
          s: '#eaf2ed',
        },
        amber: {
          DEFAULT: '#a0651a',
          s: '#fdf4e7',
        }
      },
      fontFamily: {
        sans: ['Noto Sans SC', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
      }
    }
  },
  plugins: []
};

export default config;
