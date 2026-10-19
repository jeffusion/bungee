import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { editorFixture } from '../helpers/editors/component-fixture';
const { withPage } = editorFixture(['design']);

test('form labels, editable values, placeholder hints and disabled controls have distinct rendered roles in both languages',async()=>{
  await withPage('scenario=design',async page=>{
    const roles=page.getByTestId('design-form-text-roles');
    for(const language of ['zh','en']) {
      const input=roles.locator(`#form-value-${language}`), empty=roles.locator(`#form-placeholder-${language}`), disabled=roles.locator(`#form-disabled-${language}`);
      const original=await input.inputValue();expect(original.length).toBeGreaterThan(0);
      await input.fill('edited');await expect(input).toHaveValue('edited');await expect(disabled).toBeDisabled();
      expect(await empty.getAttribute('placeholder')).toBeTruthy();await expect(empty).toHaveValue('');
      const styles=await roles.evaluate((root,language)=>{
        const value=root.querySelector<HTMLInputElement>(`#form-value-${language}`)!;
        const hint=root.querySelector<HTMLTextAreaElement>(`#form-placeholder-${language}`)!;
        const blocked=root.querySelector<HTMLInputElement>(`#form-disabled-${language}`)!;
        const label=root.querySelector<HTMLLabelElement>(`label[for="form-value-${language}"]`)!;
        const help=root.querySelector(`#${value.getAttribute('aria-describedby')}`)!;
        return {labelWeight:Number(getComputedStyle(label).fontWeight),valueWeight:Number(getComputedStyle(value).fontWeight),
          hintWeight:Number(getComputedStyle(hint,'::placeholder').fontWeight),labelSize:parseFloat(getComputedStyle(label).fontSize),
          valueSize:parseFloat(getComputedStyle(value).fontSize),help:help.textContent,disabledOpacity:parseFloat(getComputedStyle(blocked).opacity)};
      },language);
      expect(styles.labelWeight).toBeGreaterThan(styles.valueWeight);expect(styles.valueWeight).toBe(400);expect(styles.hintWeight).toBe(400);
      expect(styles.labelSize).toBeGreaterThanOrEqual(styles.valueSize);expect(styles.help).toBeTruthy();expect(styles.disabledOpacity).toBeLessThan(1);
    }
  });
},60_000);
