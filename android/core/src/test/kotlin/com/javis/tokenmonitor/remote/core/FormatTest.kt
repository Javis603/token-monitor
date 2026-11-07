package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    @Test
    fun groupedTokensWinWhenTheContainerFits() {
        assertEquals("1,234,567", Format.tokensForWidth(1_234_567) { true })
    }

    @Test
    fun compactTokensAreUsedWhenGroupedDoesNotFit() {
        assertEquals("1.2M", Format.tokensForWidth(1_234_567) { it.length < 8 })
    }

    @Test
    fun smallCountsStayExact() {
        assertEquals("980", Format.tokensForWidth(980) { false })
    }

    @Test
    fun widgetCostGroupsThousands() {
        assertEquals("$10,857.74", Format.widgetCost(10857.74, 2))
        assertEquals("$47.8", Format.widgetCost(47.83, 1))
    }
}
