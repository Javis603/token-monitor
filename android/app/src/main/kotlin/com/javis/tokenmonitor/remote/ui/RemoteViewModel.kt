package com.javis.tokenmonitor.remote.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.javis.tokenmonitor.remote.core.HubFailure
import com.javis.tokenmonitor.remote.core.PeriodId
import com.javis.tokenmonitor.remote.core.StatsSnapshot
import com.javis.tokenmonitor.remote.data.ConnectResult
import com.javis.tokenmonitor.remote.data.HubRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Tab {
    Home,
    Tools,
    Models,
    Analysis
}

data class UiState(
    val ready: Boolean = false,
    val configured: Boolean = false,
    val hubUrl: String = "",
    val snapshot: StatsSnapshot? = null,
    val failure: HubFailure? = null,
    val refreshing: Boolean = false,
    val busy: Boolean = false,
    val period: PeriodId = PeriodId.Today,
    val islandEnabled: Boolean = false,
    val connectResult: ConnectResult? = null,
    val tab: Tab = Tab.Home
)

class RemoteViewModel(private val repository: HubRepository) : ViewModel() {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            repository.ready.collect { ready -> _state.update { it.copy(ready = ready) } }
        }
        viewModelScope.launch {
            repository.hubUrl.collect { url ->
                _state.update { it.copy(hubUrl = url, configured = url.isNotBlank()) }
            }
        }
        viewModelScope.launch {
            repository.snapshot.collect { snapshot -> _state.update { it.copy(snapshot = snapshot) } }
        }
        viewModelScope.launch {
            repository.failure.collect { failure -> _state.update { it.copy(failure = failure) } }
        }
        viewModelScope.launch {
            repository.refreshing.collect { refreshing -> _state.update { it.copy(refreshing = refreshing) } }
        }
        viewModelScope.launch {
            repository.islandEnabled.collect { enabled -> _state.update { it.copy(islandEnabled = enabled) } }
        }
    }

    fun onForeground(active: Boolean) {
        repository.setForeground(active)
    }

    fun connect(url: String, secret: String) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, connectResult = null) }
            val result = withContext(Dispatchers.IO) { repository.connect(url, secret) }
            _state.update { it.copy(busy = false, connectResult = result) }
        }
    }

    fun refresh() {
        viewModelScope.launch(Dispatchers.IO) { repository.refresh() }
    }

    fun setIsland(enabled: Boolean) {
        viewModelScope.launch(Dispatchers.IO) { repository.setIslandEnabled(enabled) }
    }

    fun selectPeriod(id: PeriodId) {
        _state.update { it.copy(period = id) }
    }

    fun selectTab(tab: Tab) {
        _state.update { it.copy(tab = tab) }
    }

    fun clearConnectResult() {
        _state.update { it.copy(connectResult = null) }
    }
}

class RemoteViewModelFactory(private val repository: HubRepository) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(RemoteViewModel::class.java)) {
            @Suppress("UNCHECKED_CAST")
            return RemoteViewModel(repository) as T
        }
        error(modelClass.name)
    }
}
