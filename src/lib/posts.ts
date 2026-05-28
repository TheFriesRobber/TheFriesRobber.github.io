import type { CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

export function postSlug(post: BlogPost): string {
  return post.id.replace(/\/index\.md$/, '').replace(/\.md$/, '');
}

export function postUrl(post: BlogPost): string {
  return `/${postSlug(post)}/`;
}

export function sortPosts(posts: BlogPost[]): BlogPost[] {
  return posts
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export function uniqueTerms(posts: BlogPost[], key: 'tags' | 'categories'): string[] {
  return [...new Set(posts.flatMap((post) => post.data[key]))].sort((a, b) => a.localeCompare(b));
}
