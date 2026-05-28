import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { postUrl, sortPosts } from '../lib/posts';

export async function GET(context) {
  const posts = sortPosts(await getCollection('blog'));
  return rss({
    title: '留痕',
    description: '积跬步至千里',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: postUrl(post)
    }))
  });
}
