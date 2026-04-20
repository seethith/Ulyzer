import keytar from 'keytar';

const SERVICE = 'ulyzer';

export async function getApiKey(provider: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, provider);
}

export async function setApiKey(provider: string, key: string): Promise<void> {
  await keytar.setPassword(SERVICE, provider, key);
}

export async function deleteApiKey(provider: string): Promise<void> {
  await keytar.deletePassword(SERVICE, provider);
}
