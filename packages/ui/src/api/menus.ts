import type { MenuSnapshot, MenuWrite, MenuIconCollections, MenuIconSearch, MenuIcons } from '@jeffusion/bungee-types';
import { api } from './client';
export const MenusAPI = {
  read: () => api.get<MenuSnapshot>('/ui/menus'),
  save: (write: MenuWrite) => api.put<MenuSnapshot>('/ui/menus', write),
  collections: () => api.get<MenuIconCollections>('/ui/icons/collections'),
  search: (collection: string, q: string, offset = 0) => api.get<MenuIconSearch>(`/ui/icons/search?${new URLSearchParams({ collection, q, offset: String(offset), limit: '48' })}`),
  icons: (ids: readonly string[]) => api.get<MenuIcons>(`/ui/icons/data?${new URLSearchParams({ ids: ids.join(',') })}`),
};
