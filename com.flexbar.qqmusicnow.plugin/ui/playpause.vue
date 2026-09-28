<template>
  <v-container class="control-settings">
    <v-card flat>
      <v-card-title class="text-subtitle-1">
        <v-icon class="mr-2" size="small">mdi-play-pause</v-icon>
        {{ $t('PlayPause.Title') }}
      </v-card-title>
      <v-card-text>
        <p class="text-body-2">{{ $t('PlayPause.Tip') }}</p>
        <p class="text-caption mt-2">{{ $t('PlayPause.Note') }}</p>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'PlayPauseSettings',
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
