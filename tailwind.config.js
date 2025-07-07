/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}", // This covers all relevant files in the src folder
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
