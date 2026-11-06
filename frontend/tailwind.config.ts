import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "var(--paper)",
        bench: "var(--bench)",
        ink: {
          DEFAULT: "var(--ink)",
          2: "var(--ink-2)",
        },
        rule: "var(--rule)",
        signal: "var(--signal)",
        refuse: "var(--refuse)",
      },
      borderColor: {
        DEFAULT: "var(--rule)",
      },
      fontFamily: {
        sans: ["var(--font-prose)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
