import {
  Archivo, Bricolage_Grotesque, DM_Sans, Fraunces, Geist, Geist_Mono, IBM_Plex_Mono, Instrument_Serif, Inter,
  JetBrains_Mono, Manrope, Outfit, Plus_Jakarta_Sans, Poppins, Sora, Space_Grotesk, Space_Mono, Urbanist,
} from 'next/font/google';

/* Every design picks its type from these CSS variables (e.g. font-family: var(--f-sora)). */
const inter = Inter({ subsets: ['latin'], variable: '--f-inter' });
const geist = Geist({ subsets: ['latin'], variable: '--f-geist' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--f-geist-mono' });
const space = Space_Grotesk({ subsets: ['latin'], variable: '--f-space' });
const spaceMono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--f-space-mono' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--f-jetbrains' });
const instrument = Instrument_Serif({ subsets: ['latin'], weight: '400', style: ['normal', 'italic'], variable: '--f-instrument' });
const manrope = Manrope({ subsets: ['latin'], variable: '--f-manrope' });
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--f-jakarta' });
const sora = Sora({ subsets: ['latin'], variable: '--f-sora' });
const urbanist = Urbanist({ subsets: ['latin'], variable: '--f-urbanist' });
const dmsans = DM_Sans({ subsets: ['latin'], variable: '--f-dmsans' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--f-fraunces' });
const outfit = Outfit({ subsets: ['latin'], variable: '--f-outfit' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--f-plex-mono' });
const archivo = Archivo({ subsets: ['latin'], variable: '--f-archivo' });
const bricolage = Bricolage_Grotesque({ subsets: ['latin'], variable: '--f-bricolage' });
const poppins = Poppins({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--f-poppins' });

export const fontVars = [
  inter, geist, geistMono, space, spaceMono, jetbrains, instrument, manrope, jakarta, sora, urbanist, dmsans, fraunces,
  outfit, plexMono, archivo, bricolage, poppins,
].map((f) => f.variable).join(' ');
