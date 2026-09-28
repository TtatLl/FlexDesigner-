<template>
  <v-container class="control-settings">
    <v-card flat>
      <v-card-title class="text-subtitle-1">
        <v-icon class="mr-2" size="small">mdi-skip-next</v-icon>
        {{ $t('Next.Title') }}
      </v-card-title>
      <v-card-text>
        <p class="text-body-2">{{ $t('Next.Tip') }}</p>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'NextSettings',
  props: {
    modelValue: { type: Object, required: true }
  },
  emits: ['update:modelValue']
};
</script>

<style scoped>
.control-settings {
  padding: 8px;
}
</style>
