import type { LetterContent, ResumeContent } from './content';

// Synthetic people only: the repo is public.
export const sampleResume: ResumeContent = {
  locale: 'de',
  header: {
    name: 'Mia Müller-Süß',
    headline: 'Köchin und Küchenhilfe',
    address: 'Beispielstraße 12, 96047 Bamberg',
    phone: '+49 951 0000000',
    email: 'mia.mueller@example.test',
    links: ['https://example.test/mia'],
  },
  experiences: [
    {
      role: 'Küchenhilfe',
      organisation: 'Gasthaus Zur Äpfelblüte',
      place: 'Bamberg',
      start: '2021-03',
      end: '2022-08',
      points: ['Gemüse und Soßen für 80 Gäste vorbereitet', 'Spülküche geführt'],
    },
    {
      role: 'Beiköchin',
      organisation: 'Café Größenwahn',
      place: 'Erlangen',
      start: '2023-01',
      end: null,
      points: ['Frühstückskarte mit Öko-Zutaten entwickelt'],
    },
  ],
  education: [
    {
      degree: 'Ausbildung zur Köchin',
      institution: 'Berufsschule Bamberg',
      place: 'Bamberg',
      start: '2018-09',
      end: '2021-02',
    },
  ],
  skills: ['Hygienekonzepte (HACCP)', 'Teamarbeit', 'Großküche'],
  languages: [
    { language: 'Deutsch', level: 'C1' },
    { language: 'Bengalisch', level: 'Muttersprache' },
  ],
  certificates: [
    { name: 'Hygieneschulung nach §43 IfSG', issuer: 'Gesundheitsamt Bamberg', date: '2020-05' },
  ],
};

export const sampleLetter: LetterContent = {
  locale: 'de',
  sender: {
    name: 'Mia Müller-Süß',
    address: 'Beispielstraße 12, 96047 Bamberg',
    email: 'mia.mueller@example.test',
  },
  recipient: {
    company: 'Brauerei Fröhlich GmbH',
    contact: 'Frau Schäfer',
    address: 'Hafenweg 3, 96047 Bamberg',
  },
  place: 'Bamberg',
  date: '2026-11-25',
  subject: 'Bewerbung als Küchenhilfe',
  salutation: 'Sehr geehrte Frau Schäfer,',
  paragraphs: [
    'mit großer Freude habe ich Ihre Anzeige gelesen. Als gelernte Köchin bringe ich Erfahrung aus der Großküche mit.',
    'Gern überzeuge ich Sie in einem persönlichen Gespräch.',
  ],
  signOff: 'Mit freundlichen Grüßen',
  signature: 'Mia Müller-Süß',
};
