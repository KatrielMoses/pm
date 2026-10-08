import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { designs, designById } from '@/designs/meta';
import { MockupView } from '@/components/MockupView';

export function generateStaticParams() {
  return designs.map((d) => ({ id: String(d.id) }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const d = designById(Number((await params).id));
  return { title: d ? `${String(d.id).padStart(2, '0')} · ${d.name}` : 'Mockup' };
}

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ embed?: string }> }) {
  const id = Number((await params).id);
  if (!designById(id)) notFound();
  const embed = (await searchParams).embed === '1';
  return <MockupView id={id} embed={embed} />;
}
