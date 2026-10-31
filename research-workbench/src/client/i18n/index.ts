import { app } from './zh/app';
import { domain } from './zh/domain';
import { model } from './zh/model';
import { pages } from './zh/pages';
import { records } from './zh/records';

/** Traditional Chinese dictionary, keyed by the English text. Split by area so files stay readable. */
export const zhTW: Record<string, string> = { ...domain, ...app, ...model, ...pages, ...records };
