import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://thefriesrobber.github.io',
  markdown: {
    shikiConfig: {
      theme: 'github-light'
    }
  }
});
