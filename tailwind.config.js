/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./thank-you.html",
    "./contribute/**/*.html",
    "./from-the-bay/**/*.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'charcoal': '#1A1A1A',
        'gold': '#D4AF37',
        'ivory': '#F3F4F6',
      }
    },
  },
  plugins: [],
}
