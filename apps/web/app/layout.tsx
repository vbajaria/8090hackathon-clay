import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Leadwork — Private lead workspace', description: 'Prepare leads, review generated drafts, and export saved work.' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
