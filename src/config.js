// Configuración leída de variables de entorno (o de un archivo .env, que nunca se sube al repo).

import { existsSync, readFileSync } from 'node:fs';

// Carga mínima de .env sin dependencias: KEY=valor por línea; ignora comentarios.
// Las variables ya definidas en el entorno tienen prioridad sobre el archivo.
function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  host: env.HOST || '127.0.0.1',
  apiKey: env.MORSIS_API_KEY || '',
  baseUrl: env.MORSIS_BASE_URL || 'https://api-staging.morsis.com/v1',
  // Sin API key, la demo usa el Morsis simulado.
  mode: env.MORSIS_API_KEY ? 'real' : 'mock',
  branchId: env.MORSIS_BRANCH_ID || '',
  actorUserId: env.MORSIS_ACTOR_USER_ID || '', // el modo demo no lo valida; en modo real es obligatorio
  externalDeviceId: env.EXTERNAL_DEVICE_ID || 'CAJA-1',
  invoice: {
    issuerTaxId: env.INVOICE_ISSUER_TAX_ID || '30712345678',
    issuerName: env.INVOICE_ISSUER_NAME || 'Empresa externa SA',
    typeCode: Number(env.INVOICE_TYPE_CODE) || 6,
    pointOfSale: Number(env.INVOICE_POINT_OF_SALE) || 1,
  },
};
