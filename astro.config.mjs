import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://leadtogu.github.io',
  markdown: {
    shikiConfig: {
      theme: 'github-light'
    }
  }
});
