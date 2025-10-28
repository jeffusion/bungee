<script lang="ts">
  import { _ } from '../lib/i18n';
  import { login } from '../lib/stores/auth';
  import { loginWithToken } from '../lib/api/auth';
  import { toast } from '../lib/stores/toast';

  let tokenInput = '';
  let loading = false;
  let error = '';

  async function handleLogin() {
    // 1. 验证输入
    if (!tokenInput.trim()) {
      error = $_('login.required');
      return;
    }

    loading = true;
    error = '';

    try {
      // 2. 调用登录 API
      const result = await loginWithToken(tokenInput);

      if (result.success) {
        // 3. 登录成功：保存 token 并跳转
        login(tokenInput);
        toast.show($_('login.success'), 'success');
        window.location.hash = '#/';
      } else {
        // 4. 登录失败：显示错误
        error = result.error || $_('login.unauthorized');
      }
    } catch (err) {
      // 5. 网络错误或其他异常
      error = $_('login.failed', { values: { error: (err as Error).message } });
    } finally {
      loading = false;
    }
  }

  function handleKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter' && !loading) {
      handleLogin();
    }
  }
</script>

<div class="min-h-screen bg-base-200 flex items-center justify-center p-4">
  <div class="card w-full max-w-md bg-base-100 shadow-2xl">
    <div class="card-body">
      <!-- Logo and Title -->
      <div class="flex flex-col items-center mb-6">
        <!-- Logo Icon -->
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-16 w-16 text-primary mb-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>

        <!-- Title and Subtitle -->
        <h1 class="text-3xl font-bold text-center">{$_('login.title')}</h1>
        <p class="text-sm text-base-content/60 text-center mt-2">
          {$_('login.subtitle')}
        </p>
      </div>

      <!-- Token Input Form -->
      <div class="form-control w-full">
        <label class="label" for="token-input">
          <span class="label-text">{$_('login.token')}</span>
        </label>
        <input
          id="token-input"
          type="password"
          placeholder={$_('login.tokenPlaceholder')}
          class="input input-bordered w-full"
          class:input-error={!!error}
          bind:value={tokenInput}
          on:keypress={handleKeyPress}
          disabled={loading}
          autocomplete="off"
        />

        <!-- Error Message -->
        {#if error}
          <div class="label">
            <span class="label-text-alt text-error">{error}</span>
          </div>
        {/if}
      </div>

      <!-- Login Button -->
      <div class="form-control mt-6">
        <button
          class="btn btn-primary"
          class:loading={loading}
          on:click={handleLogin}
          disabled={loading}
        >
          {loading ? $_('login.loggingIn') : $_('login.submit')}
        </button>
      </div>

      <!-- Additional Info (Optional) -->
      <div class="divider text-xs opacity-50 mt-6">Bungee Reverse Proxy</div>
    </div>
  </div>
</div>

<style>
  /* Additional custom styles if needed */
  .card {
    backdrop-filter: blur(10px);
  }
</style>
