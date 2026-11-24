import { getExternalResourceURL } from '@decky/api';

export function plexMediaUrl(url: string, localConnection?: boolean): string {
  // A LAN HTTP source can be blocked or upgraded to HTTPS by Steam's webview.
  if (!localConnection || !url.startsWith('http://')) return url;
  // Decky's fetch route decodes the URL after parsing the outer query string.
  return getExternalResourceURL(url.replace(/%/g, '%25'));
}
