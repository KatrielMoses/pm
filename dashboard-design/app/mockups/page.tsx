import Link from 'next/link';
import { designs } from '@/designs/meta';
import { Thumb } from '@/components/Thumb';
import styles from './gallery.module.css';

export const metadata = { title: 'Mockups · Round 1' };

export default function Gallery() {
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}>Round 1 · Owner home</p>
          <h1 className={styles.title}>20 directions</h1>
        </div>
        <p className={styles.hint}><Link href="/app" style={{ color: '#fff', marginRight: 16 }}>Open the app (Paper) →</Link>← → to move · B brand · H hide bar</p>
      </header>
      <div className={styles.grid}>
        {designs.map((d) => (
          <Link key={d.id} href={`/mockups/${d.id}`} className={styles.card}>
            <Thumb id={d.id} title={d.name} className={styles.thumb} />
            <div className={styles.meta}>
              <span className={styles.num}>{String(d.id).padStart(2, '0')}</span>
              <span className={styles.name}>{d.name}</span>
              <span className={styles.sw}>{d.house.colors.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
            </div>
            <p className={styles.vibe}>{d.vibe}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
