import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const stringList = z.union([z.string(), z.array(z.string())]).transform((value) => (
  Array.isArray(value) ? value : [value]
));

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    categories: stringList.default([]),
    tags: stringList.default([]),
    draft: z.boolean().default(false)
  })
});

export const collections = { blog };
