<script lang="ts">
  import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";

  type $$Props = SonnerProps;
</script>

<Sonner
	theme="dark"
	class="toaster group"
	toastOptions={{
		classes: {
toast: "group toast group-[.toaster]:bg-carbon-800 group-[.toaster]:text-carbon-100 group-[.toaster]:border-carbon-700 group-[.toaster]:shadow-lg",
      description: "group-[.toast]:text-carbon-400",
      actionButton: "group-[.toast]:bg-nexus-500 group-[.toast]:text-black",
      cancelButton: "group-[.toast]:bg-carbon-700 group-[.toast]:text-carbon-400",
		},
	}}
	{...$$restProps}
/>
