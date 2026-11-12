import test from 'node:test';
import assert from 'node:assert/strict';
import { collabSelectionMetadata } from '../src/runtime/collab-selection.ts';

test('native selection metadata preserves checked indices and markable action boundary', () => {
  assert.deepEqual(collabSelectionMetadata({selectionMarker:'checkbox',checkedIndices:[1,1],markableCount:2,helpText:'Enter selects'},4), {
    selectionMarker:'checkbox',checkedIndices:[1],markableCount:2,helpText:'Enter selects',
  });
  assert.deepEqual(collabSelectionMetadata({selectionMarker:'checkbox',checkedIndices:[]},2), {
    selectionMarker:'checkbox',checkedIndices:[],markableCount:2,
  });
});
test('arbitrary Done labels never create multi-selection and invalid metadata cannot mark actions', () => {
  assert.deepEqual(collabSelectionMetadata({options:['Done selecting','Other']},2),{});
  for(const metadata of [
    {selectionMarker:'checkbox',markableCount:3},
    {selectionMarker:'checkbox',markableCount:-1},
    {selectionMarker:'checkbox',markableCount:1,checkedIndices:[1]},
    {selectionMarker:'checkbox',checkedIndices:[0.5]},
    {selectionMarker:'invented',checkedIndices:[0]},
  ]) assert.deepEqual(collabSelectionMetadata(metadata,2),{});
});
