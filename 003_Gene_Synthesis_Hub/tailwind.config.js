/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Space Grotesk", "IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "Menlo", "monospace"],
      },
      colors: {
        ink: {
          900: "#0B1426",
          800: "#0F1E3A",
          700: "#16294B",
          600: "#1F3A66",
          500: "#2C4F87",
        },
        accent: {
          400: "#5BA8FF",
          500: "#3F8AE0",
          600: "#2C6BB8",
        },
        good: "#08A308",
        bad: "#FF4C4C",
        warn: "#FFA53F",
      },
    },
  },
  plugins: [],
};
