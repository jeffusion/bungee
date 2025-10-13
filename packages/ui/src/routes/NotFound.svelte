<script lang="ts">
  import { _ } from '../lib/i18n';
</script>

<div class="flex flex-col items-center justify-center h-screen">
  <h1 class="text-6xl font-bold mb-4">{$_('notFound.title')}</h1>
  <p class="text-2xl mb-8">{$_('notFound.message')}</p>
  <a href="/__ui/#/" class="btn btn-primary">{$_('notFound.goHome')}</a>
</div>
