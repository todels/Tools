import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://jtyecjkdytklduivybah.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0eWVjamtkeXRrbGR1aXZ5YmFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjgsImV4cCI6MjA5NjMxMDUyOH0.DPMjU17YvBF0E1DDtKopzPkkRnQc63MQ4wYpaM013D0'
);

const BASE = 'https://jtyecjkdytklduivybah.supabase.co/storage/v1/object/public/delivr/logos/';

const clients = [
  { name: 'Altura',      color: '#5B9CF6', logo: BASE + 'Altura.png' },
  { name: 'BAYC',        color: '#5B9CF6', logo: BASE + 'BAYC.png' },
  { name: 'Bruce Lee',   color: '#5B9CF6', logo: BASE + 'Bruce%20Lee.png' },
  { name: 'Chain',       color: '#5B9CF6', logo: BASE + 'Chain.png' },
  { name: 'Degen',       color: '#5B9CF6', logo: BASE + 'Degen.png' },
  { name: 'Dreamworks',  color: '#5B9CF6', logo: BASE + 'Dreamworks.png' },
  { name: 'Sandbox',     color: '#5B9CF6', logo: BASE + 'Sandbox.png' },
  { name: 'Sixr',        color: '#5B9CF6', logo: BASE + 'Sixr.png' },
  { name: 'Sport.fun',   color: '#5B9CF6', logo: BASE + 'Sport.fun.png' },
  { name: 'Thrust',      color: '#5B9CF6', logo: BASE + 'Thrust.png' },
  { name: 'WSJ',         color: '#5B9CF6', logo: BASE + 'WSJ.png' },
  { name: 'Whop',        color: '#5B9CF6', logo: BASE + 'Whop.png' },
  { name: 'Zama',        color: '#5B9CF6', logo: BASE + 'Zama.png' },
];

await sb.storage.from('delivr').remove(['clients.json']);
const blob = new Blob([JSON.stringify(clients)], { type: 'application/json' });
const { error } = await sb.storage.from('delivr').upload('clients.json', blob);
if (error) console.error('❌', error.message);
else console.log('✓ clients.json seeded with', clients.length, 'clients');
