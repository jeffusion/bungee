<script lang="ts">
  // Design System Showcase
  // This route is for visualizing the design system components and tokens.
</script>

<div class="p-6 max-w-6xl mx-auto space-y-12">
  <!-- Header -->
  <div class="space-y-4">
    <div class="text-sm breadcrumbs">
      <ul>
        <li><a href="#/">Home</a></li>
        <li>Design System</li>
      </ul>
    </div>
    <h1 class="text-3xl font-bold">Bungee Design System</h1>
    <p class="text-base-content/70 max-w-2xl">
      A comprehensive guide to the visual language and components used in the Bungee application.
      This system ensures consistency, accessibility, and maintenance efficiency.
    </p>
  </div>

  <!-- Colors -->
  <section class="space-y-6">
    <h2 class="text-xl font-semibold border-b border-base-200 pb-2">Colors & Theming</h2>
    
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card bg-base-100 shadow-sm border border-base-200">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">Base Colors</h3>
          <div class="flex flex-col gap-2 mt-2">
            <div class="h-12 w-full bg-base-100 rounded flex items-center justify-center text-xs border border-base-200">base-100</div>
            <div class="h-12 w-full bg-base-200 rounded flex items-center justify-center text-xs">base-200</div>
            <div class="h-12 w-full bg-base-300 rounded flex items-center justify-center text-xs">base-300</div>
          </div>
        </div>
      </div>

      <div class="card bg-base-100 shadow-sm border border-base-200">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">Semantic Colors</h3>
          <div class="flex flex-col gap-2 mt-2">
            <div class="h-12 w-full bg-primary text-primary-content rounded flex items-center justify-center text-xs">primary</div>
            <div class="h-12 w-full bg-secondary text-secondary-content rounded flex items-center justify-center text-xs">secondary</div>
            <div class="h-12 w-full bg-accent text-accent-content rounded flex items-center justify-center text-xs">accent</div>
            <div class="h-12 w-full bg-neutral text-neutral-content rounded flex items-center justify-center text-xs">neutral</div>
          </div>
        </div>
      </div>

      <div class="card bg-base-100 shadow-sm border border-base-200">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">Status Colors</h3>
          <div class="flex flex-col gap-2 mt-2">
            <div class="h-12 w-full bg-info text-info-content rounded flex items-center justify-center text-xs">info</div>
            <div class="h-12 w-full bg-success text-success-content rounded flex items-center justify-center text-xs">success</div>
            <div class="h-12 w-full bg-warning text-warning-content rounded flex items-center justify-center text-xs">warning</div>
            <div class="h-12 w-full bg-error text-error-content rounded flex items-center justify-center text-xs">error</div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Typography -->
  <section class="space-y-6">
    <h2 class="text-xl font-semibold border-b border-base-200 pb-2">Typography</h2>
    
    <div class="card bg-base-100 shadow-sm border border-base-200 overflow-x-auto">
      <table class="table w-full">
        <thead>
          <tr>
            <th class="w-32">Scale</th>
            <th class="w-48">Class</th>
            <th>Example</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Heading 1</td>
            <td><code>text-2xl font-bold</code></td>
            <td><span class="text-2xl font-bold">The quick brown fox</span></td>
          </tr>
          <tr>
            <td>Heading 2</td>
            <td><code>text-lg font-semibold</code></td>
            <td><span class="text-lg font-semibold">The quick brown fox</span></td>
          </tr>
          <tr>
            <td>Body</td>
            <td><code>text-base</code></td>
            <td><span class="text-base">The quick brown fox jumps over the lazy dog.</span></td>
          </tr>
          <tr>
            <td>Small</td>
            <td><code>text-sm</code></td>
            <td><span class="text-sm">The quick brown fox jumps over the lazy dog.</span></td>
          </tr>
          <tr>
            <td>Tiny</td>
            <td><code>text-xs</code></td>
            <td><span class="text-xs">The quick brown fox jumps over the lazy dog.</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- Buttons -->
  <section class="space-y-6">
    <h2 class="text-xl font-semibold border-b border-base-200 pb-2">Buttons</h2>
    
    <div class="flex flex-wrap gap-4 p-4 bg-base-100 rounded-box border border-base-200">
      <button class="btn">Default</button>
      <button class="btn btn-primary">Primary</button>
      <button class="btn btn-secondary">Secondary</button>
      <button class="btn btn-accent">Accent</button>
      <button class="btn btn-ghost">Ghost</button>
      <button class="btn btn-link">Link</button>
    </div>
    
    <div class="flex flex-wrap gap-4 p-4 bg-base-100 rounded-box border border-base-200">
      <button class="btn btn-outline btn-primary">Outline</button>
      <button class="btn btn-sm btn-primary">Small</button>
      <button class="btn btn-xs btn-primary">Tiny</button>
      <button class="btn btn-square btn-primary">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
      <button class="btn btn-primary loading">Loading</button>
      <button class="btn btn-primary" disabled>Disabled</button>
    </div>
  </section>

  <!-- Forms -->
  <section class="space-y-6">
    <h2 class="text-xl font-semibold border-b border-base-200 pb-2">Form Elements</h2>
    
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div class="card bg-base-100 shadow-sm border border-base-200">
        <div class="card-body">
          <h3 class="card-title text-base">Input Fields</h3>
          
          <div class="form-control w-full">
            <div class="label">
              <span class="label-text">Standard Input</span>
            </div>
            <input type="text" placeholder="Type here" class="input input-bordered w-full" />
            <div class="label">
              <span class="label-text-alt">Helper text goes here</span>
            </div>
          </div>

          <div class="form-control w-full">
            <div class="label">
              <span class="label-text">Error State</span>
            </div>
            <input type="text" value="Invalid Value" class="input input-bordered input-error w-full" />
            <div class="label">
              <span class="label-text-alt text-error">This field is required</span>
            </div>
          </div>
        </div>
      </div>

      <div class="card bg-base-100 shadow-sm border border-base-200">
        <div class="card-body">
          <h3 class="card-title text-base">Select & Toggles</h3>
          
          <div class="form-control w-full">
            <div class="label">
              <span class="label-text">Select Box</span>
            </div>
            <select class="select select-bordered w-full">
              <option disabled selected>Pick one</option>
              <option>Option 1</option>
              <option>Option 2</option>
            </select>
          </div>

          <div class="form-control mt-4">
            <label class="label cursor-pointer justify-start gap-4">
              <input type="checkbox" class="toggle toggle-primary" checked />
              <span class="label-text">Toggle Switch</span>
            </label>
          </div>
          
          <div class="form-control">
             <label class="label cursor-pointer justify-start gap-4">
              <input type="checkbox" class="checkbox checkbox-primary" checked />
              <span class="label-text">Checkbox</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Cards & Layout -->
  <section class="space-y-6">
    <h2 class="text-xl font-semibold border-b border-base-200 pb-2">Cards & Layouts</h2>
    
    <div class="card bg-base-100 shadow-sm border border-base-200 max-w-lg">
      <div class="card-body">
        <h2 class="card-title">Card Title</h2>
        <p>A standard card component used for grouping related content. It features a subtle shadow and border in the default theme.</p>
        <div class="card-actions justify-end">
          <button class="btn btn-ghost btn-sm">Cancel</button>
          <button class="btn btn-primary btn-sm">Confirm</button>
        </div>
      </div>
    </div>
  </section>
  
    <!-- Alert / Feedback -->
  <section class="space-y-6 pb-12">
    <h2 class="text-xl font-semibold border-b border-base-200 pb-2">Alerts</h2>
    
    <div class="flex flex-col gap-4">
        <div class="alert alert-info shadow-sm">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          <span>New software update available.</span>
        </div>
        
        <div class="alert alert-warning shadow-sm">
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          <span>Warning: Invalid configuration detected!</span>
        </div>
    </div>
  </section>
</div>
