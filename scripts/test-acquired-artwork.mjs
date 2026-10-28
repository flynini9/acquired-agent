import assert from 'node:assert/strict';
import {artworkSrc} from '../lib/acquired/artwork.ts';
const id='A0C54500-13CF-4193-A42E-FF0B72C42F88',expected='https://images.qloo.com/i/'+id+'-420x-auto.jpg';
assert.equal(artworkSrc(undefined,id.toLowerCase()),expected);
assert.equal(artworkSrc('https://images.qloo.com/i/returned-cover.jpg',id),'https://images.qloo.com/i/returned-cover.jpg');
for(const url of ['javascript:alert(1)','data:image/png;base64,test','http://images.qloo.com/i/test.jpg','https://images.qloo.com.evil.test/x','https://user:secret@images.qloo.com/x','https://images.qloo.com:9000/x','/private-image']){
 assert.equal(artworkSrc(url),null);assert.equal(artworkSrc(url,id),expected);
}
for(const bad of ['../secret','https://example.com','not-a-uuid',id+'?key=secret'])assert.equal(artworkSrc(undefined,bad),null);
assert.equal(artworkSrc(),null);
console.log('Artwork boundary passed: Qloo image host only, no credentials/other schemes, legacy UUID mapping, unknown image fallback. No live requests.');
