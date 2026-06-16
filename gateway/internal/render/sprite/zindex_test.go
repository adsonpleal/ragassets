package sprite

import "testing"

func TestZIndex_AccessoryFrontVsBehind(t *testing.T) {
	body := &Sprite{Type: TypePlayerBody}
	acc := &Sprite{Type: TypeAccessory, TypeOrder: 0}

	// Normal accessory draws in front of the body (higher z) in both direction
	// groups.
	for _, dir := range []int{0, 3} { // 0 = non-top-left, 3 = top-left
		bz := ZIndexForSprite(body, dir, -1, -1, nil)
		az := ZIndexForSprite(acc, dir, -1, -1, nil)
		if az <= bz {
			t.Errorf("dir %d: accessory z=%d should be > body z=%d (front)", dir, az, bz)
		}
	}

	// A "behind" accessory draws below the body (lower z) in both direction groups.
	acc.Behind = true
	for _, dir := range []int{0, 3} {
		bz := ZIndexForSprite(body, dir, -1, -1, nil)
		az := ZIndexForSprite(acc, dir, -1, -1, nil)
		if az >= bz {
			t.Errorf("dir %d: behind accessory z=%d should be < body z=%d", dir, az, bz)
		}
		if az <= -1 { // must still be above the shadow (-1)
			t.Errorf("dir %d: behind accessory z=%d should be > shadow (-1)", dir, az)
		}
	}
}

func TestZIndex_BehindOnlyAccessories(t *testing.T) {
	// The Behind flag must not affect non-accessory sprites.
	head := &Sprite{Type: TypePlayerHead, Behind: true}
	if got := ZIndexForSprite(head, 0, -1, -1, nil); got != 15 {
		t.Errorf("behind flag changed head z to %d, want 15", got)
	}
}
